package analytics

import (
	"context"
	"math"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
)

// TestCurrentMarketEstimateBacktest measures the current-market estimate against real sales:
// every sampled sale of this year is estimated from the other sales (the subject is excluded by
// id) and compared with its own price, once per methodology variant. It prints, per variant and
// property group, how many sales got an estimate, the median absolute error, the median signed
// error (bias), how often the price fell inside the shown p25–p75 band, and how often the
// comparables came from within 5 km. Opt in with ESTIMATE_BACKTEST=<sample size> (and
// TEST_DATABASE_URL); it is a measurement, not a pass/fail test.
func TestCurrentMarketEstimateBacktest(t *testing.T) {
	size, _ := strconv.Atoi(os.Getenv("ESTIMATE_BACKTEST"))
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if size <= 0 || databaseURL == "" {
		t.Skip("set ESTIMATE_BACKTEST=<sample size> and TEST_DATABASE_URL to run the estimate backtest")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	now := time.Now()

	type subject struct {
		id             int64
		group          string
		area, price    float64
		year           *int
		municipalityID *int64
		signature      string
		date           time.Time
	}
	rows, err := pool.Query(ctx, `
		SELECT transaction_id, property_group, area::float8, price::float8, construction_year, municipality_id,
		       analytics.sale_package_signature(transaction_id), contract_date
		FROM analytics.sale_facts
		WHERE representative_eligible AND contract_date >= make_date($1, 1, 1) AND property_group IN ('apartment', 'house')
		  AND location IS NOT NULL AND price > 0 AND area > 0
		  AND transaction_id NOT IN (SELECT candidate_transaction_id FROM analytics.near_duplicate_candidates WHERE transaction_kind = 'sale')
		ORDER BY md5(transaction_id::text) LIMIT $2`, now.Year(), size)
	if err != nil {
		t.Fatalf("sample: %v", err)
	}
	var subjects []subject
	for rows.Next() {
		var item subject
		if err := rows.Scan(&item.id, &item.group, &item.area, &item.price, &item.year, &item.municipalityID, &item.signature, &item.date); err != nil {
			t.Fatalf("scan sample: %v", err)
		}
		subjects = append(subjects, item)
	}
	rows.Close()
	t.Logf("sample: %d sales of %d (ordered by md5 of the id, so the same for every variant)", len(subjects), now.Year())

	variants := []struct {
		name    string
		options currentMarketOptions
	}{
		{"v4: composition gate, strict support", currentMarketOptions{compositionAsGate: true}},
		{"composition as preference (flats)", currentMarketOptions{}},
		{"wide location support", currentMarketOptions{compositionAsGate: true, wideLocationSupport: true}},
		{"v5: preference (flats) + wide support", currentMarketDefaults},
		{"v5 + only sales after the subject's", currentMarketOptions{wideLocationSupport: true, afterSubject: true}},
	}
	type tally struct {
		errors, signed                       []float64
		n, estimated, inBand, near, adjusted int
	}
	median := func(values []float64) float64 {
		if len(values) == 0 {
			return math.NaN()
		}
		sorted := append([]float64(nil), values...)
		sort.Float64s(sorted)
		return sorted[len(sorted)/2]
	}
	for _, variant := range variants {
		tx, err := database.BeginReadOnly(ctx, pool, pgx.RepeatableRead)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		tallies := map[string]*tally{"apartment": {}, "house": {}, "all": {}}
		for _, item := range subjects {
			options := variant.options
			estimate, err := loadCurrentMarketEstimate(ctx, tx, currentMarketQuery{
				table: "analytics.sale_facts_strict_land", subjectTable: "analytics.sale_facts", amountColumn: "price_per_sqm",
				transactionKind: "sale", subjectID: item.id, propertyGroup: item.group, area: item.area,
				constructionYear: item.year, packageSignature: item.signature, municipalityID: item.municipalityID,
				now: now, since: item.date, options: &options,
			})
			if err != nil {
				t.Fatalf("estimate %d: %v", item.id, err)
			}
			for _, group := range []string{item.group, "all"} {
				tallies[group].n++
				if estimate == nil {
					continue
				}
				tallies[group].estimated++
				signed := estimate.CentralTotal/item.price - 1
				tallies[group].signed = append(tallies[group].signed, signed*100)
				tallies[group].errors = append(tallies[group].errors, math.Abs(signed)*100)
				if item.price >= estimate.LowerTotal && item.price <= estimate.UpperTotal {
					tallies[group].inBand++
				}
				if estimate.MaximumRadiusMeters <= 5000 {
					tallies[group].near++
				}
				if estimate.LocationAdjustmentApplied {
					tallies[group].adjusted++
				}
			}
		}
		_ = tx.Rollback(ctx)
		for _, group := range []string{"apartment", "house", "all"} {
			result := tallies[group]
			percent := func(count int) float64 { return 100 * float64(count) / math.Max(1, float64(result.estimated)) }
			t.Logf("%-44s %-9s n=%-4d estimated=%3.0f%%  MdAPE=%5.1f%%  bias=%+5.1f%%  in p25–p75=%3.0f%%  ≤5 km=%3.0f%%  adjusted=%3.0f%%",
				variant.name, group, result.n, 100*float64(result.estimated)/math.Max(1, float64(result.n)),
				median(result.errors), median(result.signed), percent(result.inBand), percent(result.near), percent(result.adjusted))
		}
	}
}

// TestCurrentMarketEstimateForOne prints one sale's estimate under every variant, with its
// comparables' places, to read a concrete case. Opt in with ESTIMATE_ONE=<transaction id>.
func TestCurrentMarketEstimateForOne(t *testing.T) {
	id, _ := strconv.ParseInt(os.Getenv("ESTIMATE_ONE"), 10, 64)
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if id == 0 || databaseURL == "" {
		t.Skip("set ESTIMATE_ONE=<transaction id> and TEST_DATABASE_URL")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	var group, signature string
	var area, price float64
	var year *int
	var municipalityID *int64
	var date time.Time
	if err := pool.QueryRow(ctx, `SELECT property_group, area::float8, price::float8, construction_year, municipality_id,
		analytics.sale_package_signature(transaction_id), contract_date FROM analytics.sale_facts WHERE transaction_id = $1`, id).
		Scan(&group, &area, &price, &year, &municipalityID, &signature, &date); err != nil {
		t.Fatalf("subject: %v", err)
	}
	t.Logf("subject %d: %s %.1f m², paid %.0f € (%.0f €/m²)", id, group, area, price, price/area)
	for _, variant := range []struct {
		name    string
		options currentMarketOptions
	}{
		{"v4: gate, strict support", currentMarketOptions{compositionAsGate: true}},
		{"composition as preference", currentMarketOptions{}},
		{"wide location support", currentMarketOptions{compositionAsGate: true, wideLocationSupport: true}},
		{"v5: preference + wide support", currentMarketDefaults},
		{"v5 + after the subject's date", currentMarketOptions{wideLocationSupport: true, afterSubject: true}},
	} {
		tx, err := database.BeginReadOnly(ctx, pool, pgx.RepeatableRead)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		options := variant.options
		estimate, err := loadCurrentMarketEstimate(ctx, tx, currentMarketQuery{
			table: "analytics.sale_facts_strict_land", subjectTable: "analytics.sale_facts", amountColumn: "price_per_sqm",
			transactionKind: "sale", subjectID: id, propertyGroup: group, area: area, constructionYear: year,
			packageSignature: signature, municipalityID: municipalityID, now: time.Now(), since: date, options: &options,
		})
		_ = tx.Rollback(ctx)
		if err != nil {
			t.Fatalf("estimate: %v", err)
		}
		if estimate == nil {
			t.Logf("%-28s no estimate", variant.name)
			continue
		}
		places := map[string]int{}
		for _, comparable := range estimate.Comparables {
			name := "?"
			if comparable.Settlement != nil {
				name = *comparable.Settlement
			}
			places[name]++
		}
		t.Logf("%-28s %.0f–%.0f–%.0f € (%.0f €/m²)  n=%d  radius=%d m  composition matched=%v  factor=%.3f (raw %.3f, local n=%d)  places=%v",
			variant.name, estimate.LowerTotal, estimate.CentralTotal, estimate.UpperTotal, estimate.CentralAmountPerSQM,
			estimate.ComparableCount, estimate.MaximumRadiusMeters, estimate.PackageCompositionMatched,
			estimate.LocationAdjustmentFactor, estimate.RawLocationFactor, estimate.LocalAdjustmentSampleSize, places)
	}
}
