package affordability

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

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
	// A rule valid from 2100 and wages of a test geography: newer than anything real.
	if _, err := tx.Exec(ctx, `
		INSERT INTO analytics.lending_rules(valid_from,dsti_max,min_remaining_income,recommended_ltv_primary,source_url,note)
		VALUES (DATE '2100-01-01',0.5,800,0.8,'https://example.test/rule','test rule')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO analytics.context_series(source,series,geography_key,period,value,unit,source_table) VALUES
		  ('surs','net_wage_p50','municipality:99990','2099M09',1200,'EUR','TEST'),
		  ('surs','net_wage_p50','municipality:99990','2099M10',1300,'EUR','TEST'),
		  ('surs','net_wage_p90','municipality:99990','2099M10',2500,'EUR','TEST'),
		  ('surs','net_wage_mean_monthly','municipality:99990','2099M10',1400,'EUR','TEST'),
		  ('bsi','test_rate_series','SI','2099M01',3.1,'%','TEST'),
		  ('bsi','test_rate_series','SI','2099M02',3.2,'%','TEST')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE real_estate_api"); err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(tx)

	rule, err := repository.Rule(ctx, time.Date(2100, 6, 1, 0, 0, 0, 0, time.UTC))
	if err != nil || rule.ValidFrom != "2100-01-01" || rule.DSTIMax != 0.5 || rule.MinRemainingIncome != 800 {
		t.Fatalf("rule=%+v err=%v", rule, err)
	}
	if _, err := repository.Rule(ctx, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("rule before any rule: %v", err)
	}
	wages, err := repository.Wages(ctx, "municipality:99990")
	if err != nil || len(wages) != 2 || wages[0].Series != "net_wage_p50" || wages[0].Value != 1300 || wages[1].Series != "net_wage_p90" {
		t.Fatalf("wages=%+v err=%v (newest period only, monthly mean excluded)", wages, err)
	}
	all, err := repository.AllWages(ctx)
	if err != nil || len(all["municipality:99990"]) != 2 {
		t.Fatalf("all wages for the test key=%+v err=%v", all["municipality:99990"], err)
	}
	latest, err := repository.Latest(ctx, "test_rate_series")
	if err != nil || latest.Period != "2099M02" || latest.Value != 3.2 {
		t.Fatalf("latest=%+v err=%v", latest, err)
	}
	if _, err := repository.Latest(ctx, "no_such_series"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing series error=%v", err)
	}
}
