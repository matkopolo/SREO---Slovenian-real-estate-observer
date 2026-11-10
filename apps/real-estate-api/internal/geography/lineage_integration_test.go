package geography

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLineageIntegration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var municipalityID, settlementID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO analytics.geographic_units(level,source_collection,gurs_eid,code,name,geometry_wgs84)
		VALUES ('municipality','integration-test','test-municipality',9990,'Testna občina',
		        ST_Multi(ST_MakeEnvelope(15.50,45.50,15.52,45.52,4326)))
		RETURNING id`).Scan(&municipalityID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO analytics.geographic_units(level,source_collection,gurs_eid,code,name,parent_id,geometry_wgs84)
		VALUES ('settlement','integration-test','test-settlement',99901,'Testno naselje',$1,
		        ST_Multi(ST_MakeEnvelope(15.50,45.50,15.52,45.52,4326)))
		RETURNING id`, municipalityID).Scan(&settlementID); err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(tx)
	lineage, err := repository.Lineage(ctx, settlementID)
	if err != nil || len(lineage) != 2 || lineage[0].ID != settlementID || lineage[1].ID != municipalityID ||
		lineage[1].Code == nil || *lineage[1].Code != 9990 {
		t.Fatalf("lineage=%+v err=%v", lineage, err)
	}
	if _, err := repository.Lineage(ctx, -1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing geography error=%v", err)
	}
}
