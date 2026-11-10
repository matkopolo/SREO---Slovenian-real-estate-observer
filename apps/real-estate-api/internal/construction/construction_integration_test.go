package construction

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// rolledBack opens a transaction that is rolled back when the test ends.
func rolledBack(t *testing.T) (context.Context, pgx.Tx) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return ctx, tx
}

func TestRepositoryIntegration(t *testing.T) {
	ctx, tx := rolledBack(t)
	var municipalityID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO analytics.geographic_units(level,source_collection,gurs_eid,code,name,geometry_wgs84)
		VALUES ('municipality','integration-test','test-municipality',9990,'Testna občina',
		        ST_Multi(ST_MakeEnvelope(15.50,45.50,15.52,45.52,4326)))
		RETURNING id`).Scan(&municipalityID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO analytics.cadastre_buildings(eid,cadastral_code,building_number,year_built,floors,dwellings,
		  gross_floor_area,municipality_eid,location,source_date)
		SELECT '99900000000'||i,99901,i,2020+i%2,3,CASE WHEN i=3 THEN 0 ELSE 4 END,500,'test-municipality',
		  ST_Transform(ST_SetSRID(ST_MakePoint(15.505+i*0.001,45.51),4326),3794),DATE '2026-10-01'
		FROM generate_series(1,3) i`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE real_estate_api"); err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(tx)

	summary, err := repository.Summary(ctx, Filter{GeographyID: &municipalityID, FromYear: 2020, ToYear: 2021})
	if err != nil {
		t.Fatal(err)
	}
	if summary.PermitsScope != "municipalities" || len(summary.BuildingsByYear) != 2 ||
		summary.BuildingsByYear[0] != (YearCount{Year: 2020, Buildings: 1, Dwellings: 4, GrossFloorArea: 500}) ||
		summary.BuildingsByYear[1].Buildings != 2 {
		t.Fatalf("summary=%+v", summary)
	}
	withDwellings, err := repository.Summary(ctx, Filter{GeographyID: &municipalityID, FromYear: 2020, ToYear: 2021, WithDwellings: true})
	if err != nil || len(withDwellings.BuildingsByYear) != 2 || withDwellings.BuildingsByYear[1].Buildings != 1 {
		t.Fatalf("with dwellings=%+v err=%v", withDwellings, err)
	}
	missing := int64(-1)
	if _, err := repository.Summary(ctx, Filter{GeographyID: &missing, FromYear: 2020, ToYear: 2021}); !errors.Is(err, ErrGeographyNotFound) {
		t.Fatalf("missing geography error=%v", err)
	}

	box := &[4]float64{15.50, 45.50, 15.52, 45.52}
	points, truncated, err := repository.MapFeatures(ctx, Filter{FromYear: 2020, ToYear: 2021, BoundingBox: box, MaxMapFeatures: 2}, true)
	if err != nil || len(points) != 2 || !truncated || points[0].Kind != "building" {
		t.Fatalf("points=%+v truncated=%v err=%v", points, truncated, err)
	}
	areas, _, err := repository.MapFeatures(ctx, Filter{FromYear: 2020, ToYear: 2021, BoundingBox: box, MaxMapFeatures: 10}, false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, area := range areas {
		if area.GeographyID != nil && *area.GeographyID == municipalityID {
			found = area.Buildings == 3 && area.Dwellings == 8
		}
	}
	if !found {
		t.Fatalf("fixture municipality aggregate missing or wrong: %+v", areas)
	}

	building, err := repository.Building(ctx, "999000000001")
	if err != nil || building.CadastralCode != 99901 || building.BuildingNumber != 1 || building.Municipality == nil ||
		*building.Municipality != "Testna občina" || building.SourceDate != "2026-10-01" {
		t.Fatalf("building=%+v err=%v", building, err)
	}
	if _, err := repository.Building(ctx, "1"); !errors.Is(err, ErrBuildingNotFound) {
		t.Fatalf("missing building error=%v", err)
	}
}
