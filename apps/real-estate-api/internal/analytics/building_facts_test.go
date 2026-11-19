package analytics

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

// scriptedRow answers one Scan with scan, or fails with err.
type scriptedRow struct {
	scan func(dest ...any)
	err  error
}

func (row scriptedRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	row.scan(dest...)
	return nil
}

// scriptedTx answers QueryRow calls from a queue of rows; every other pgx.Tx method panics.
type scriptedTx struct {
	pgx.Tx
	rows []scriptedRow
}

func (tx *scriptedTx) QueryRow(context.Context, string, ...any) pgx.Row {
	if len(tx.rows) == 0 {
		panic("scriptedTx: unexpected query")
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}

func cadastralPart(part string) SaleBuildingPart {
	code, building := int32(1730), "123"
	return SaleBuildingPart{CadastralMunicipalityCode: &code, BuildingNumber: &building, BuildingPartNumber: &part}
}

func unitValueRow(value float64) scriptedRow {
	return scriptedRow{scan: func(dest ...any) {
		*dest[0].(**float64) = &value
		*dest[1].(*string) = "model"
		*dest[6].(*string) = "2026-01-01"
	}}
}

// TestGeneralisedValueReportsPackagePartErrors: a part that has no official value is skipped,
// but any other failure of a package part query (a cancelled context, a broken transaction)
// must surface instead of silently shortening the package sum.
func TestGeneralisedValueReportsPackagePartErrors(t *testing.T) {
	parts := []SaleBuildingPart{cadastralPart("1"), cadastralPart("2"), cadastralPart("3")}
	broken := errors.New("connection reset")
	tx := &scriptedTx{rows: []scriptedRow{unitValueRow(100), {err: pgx.ErrNoRows}, {err: broken}}}
	if _, err := loadGeneralisedValue(context.Background(), tx, 1730, 123, 1, parts); !errors.Is(err, broken) {
		t.Fatalf("error=%v, want the part query's error", err)
	}

	value := 70.0
	partValue := scriptedRow{scan: func(dest ...any) { *dest[0].(**float64) = &value }}
	tx = &scriptedTx{rows: []scriptedRow{unitValueRow(100), partValue, {err: pgx.ErrNoRows}, partValue}}
	result, err := loadGeneralisedValue(context.Background(), tx, 1730, 123, 1, parts)
	if err != nil {
		t.Fatal(err)
	}
	if result.PackageValue == nil || *result.PackageValue != 140 || result.PackageParts != 2 {
		t.Fatalf("package=%v parts=%d, want 140 over 2 parts", result.PackageValue, result.PackageParts)
	}
}
