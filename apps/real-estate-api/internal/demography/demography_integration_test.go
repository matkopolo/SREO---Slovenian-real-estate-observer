package demography

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRepositoryIntegration(t *testing.T) {
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
	var settlementID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO analytics.geographic_units(level,source_collection,gurs_eid,code,name,geometry_wgs84)
		VALUES ('settlement','integration-test','test-settlement',99901,'Testno naselje',
		        ST_Multi(ST_MakeEnvelope(15.50,45.50,15.52,45.52,4326)))
		RETURNING id`).Scan(&settlementID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE real_estate_api"); err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(tx)
	profile, err := repository.Profile(ctx, nil)
	if errors.Is(err, ErrUnavailable) {
		t.Skip("SURS demographic tables are not synchronised in this database")
	}
	if err != nil || profile.Geography.Level != "country" || profile.Population.Total <= 0 {
		t.Fatalf("country profile=%+v err=%v", profile.Geography, err)
	}
	if _, err := repository.Profile(ctx, &settlementID); !errors.Is(err, ErrUnsupportedLevel) {
		t.Fatalf("settlement profile error=%v", err)
	}
	missing := int64(-1)
	if _, err := repository.Profile(ctx, &missing); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing geography error=%v", err)
	}
	municipalities, err := repository.Municipalities(ctx)
	if err != nil || len(municipalities) < 200 {
		t.Fatalf("municipalities=%d err=%v", len(municipalities), err)
	}
	for index := 1; index < len(municipalities); index++ {
		if municipalities[index-1].Name > municipalities[index].Name {
			t.Fatalf("municipalities are not sorted by name at %d", index)
		}
	}
}
