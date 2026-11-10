package analytics

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The fixture below lives in a rolled-back transaction: a municipality and a settlement of its
// own (so geography filters isolate it from any real data), two buildings with five sales and
// three rentals. The repository reads through the transaction as the API role.
const (
	fixtureBase          int64 = 9_990_000_000_000
	fixtureCadastralCode       = 99901
)

type repositoryFixture struct {
	tx             pgx.Tx
	municipalityID int64
	settlementID   int64
	sourceFileID   int64
}

func newRepositoryFixture(t *testing.T) (context.Context, *repositoryFixture) {
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
	fixture := &repositoryFixture{tx: tx}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("fixture: %v\n%s", err, sql)
		}
	}
	scan := func(destination any, sql string, args ...any) {
		t.Helper()
		if err := tx.QueryRow(ctx, sql, args...).Scan(destination); err != nil {
			t.Fatalf("fixture: %v\n%s", err, sql)
		}
	}
	scan(&fixture.municipalityID, `
		INSERT INTO analytics.geographic_units(level,source_collection,gurs_eid,code,name,geometry_wgs84)
		VALUES ('municipality','integration-test','test-municipality',9990,'Testna občina',
		        ST_Multi(ST_MakeEnvelope(15.50,45.50,15.52,45.52,4326)))
		RETURNING id`)
	scan(&fixture.settlementID, `
		INSERT INTO analytics.geographic_units(level,source_collection,gurs_eid,code,name,parent_id,geometry_wgs84)
		VALUES ('settlement','integration-test','test-settlement',99901,'Testno naselje',$1,
		        ST_Multi(ST_MakeEnvelope(15.50,45.50,15.52,45.52,4326)))
		RETURNING id`, fixture.municipalityID)
	exec(`INSERT INTO cadastral_municipalities(code,name) VALUES ($1,'Testna k.o.') ON CONFLICT DO NOTHING`, fixtureCadastralCode)
	scan(&fixture.sourceFileID, `
		INSERT INTO source_files(file_name,dataset_year,dataset_type,dataset_scope,sha256)
		VALUES ('repository-integration.zip',2024,'sales','national',md5(random()::text)||md5(random()::text))
		RETURNING id`)

	// Five sales: building 1 has four (one not representative), building 2 one.
	// i: price, area, date, building
	exec(`
		WITH sale(i,price,area,day,building) AS (VALUES
		  (0,200000,50,DATE '2024-03-01','1'),(1,150000,60,DATE '2024-05-01','1'),
		  (2,300000,100,DATE '2024-07-01','1'),(3,90000,30,DATE '2024-09-01','1'),
		  (4,500000,80,DATE '2024-11-01','2'))
		INSERT INTO transactions(transaction_id,contract_date,contract_price,dataset_year,source_file_id)
		SELECT $1::bigint+i,day,price,2024,$2 FROM sale`, fixtureBase, fixture.sourceFileID)
	exec(`
		WITH sale(i,price,area,day,building) AS (VALUES
		  (0,200000,50,DATE '2024-03-01','1'),(1,150000,60,DATE '2024-05-01','1'),
		  (2,300000,100,DATE '2024-07-01','1'),(3,90000,30,DATE '2024-09-01','1'),
		  (4,500000,80,DATE '2024-11-01','2')),
		point AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(15.51,45.51),4326),3794) p)
		INSERT INTO analytics.sale_facts(transaction_id,contract_date,dataset_year,property_group,
		  building_part_count,land_parcel_count,primary_property_count,area,price,price_per_sqm,
		  price_derivation,is_quality_eligible,representative_eligible,location,municipality_id,settlement_id,
		  cadastral_municipality_code,building_number,construction_year)
		SELECT $1::bigint+i,day,2024,'apartment',1,0,1,area,price,price/area,'single_primary_transaction_price',
		  true,i<>3,ST_Translate(point.p,i*5,0),$2,$3,$4,building,1990+i
		FROM sale CROSS JOIN point`, fixtureBase, fixture.municipalityID, fixture.settlementID, fixtureCadastralCode)
	exec(`
		INSERT INTO building_parts(transaction_id,cadastral_municipality_code,building_number,building_part_number,
		  settlement,street,house_number,municipality_name,building_part_type,sold_area,centroid_e,centroid_n,
		  dataset_year,source_file_id,source_row_number)
		SELECT f.transaction_id,f.cadastral_municipality_code,f.building_number,'1','TESTNO NASELJE',
		  CASE f.building_number WHEN '1' THEN 'TESTNA ULICA' ELSE 'DRUGA ULICA' END,
		  CASE f.building_number WHEN '1' THEN '5' ELSE '7' END,'TESTNA OBČINA',2,f.area,
		  ST_X(f.location),ST_Y(f.location),2024,$2,(f.transaction_id-$1::bigint)::int+1
		FROM analytics.sale_facts f WHERE f.transaction_id BETWEEN $1::bigint AND $1::bigint+4`, fixtureBase, fixture.sourceFileID)

	// Three rentals in building 1.
	exec(`
		INSERT INTO rental_transactions(transaction_id,contract_date,contract_rent,dataset_year,source_file_id)
		SELECT $1::bigint+100+i,DATE '2024-02-01'+i*30,600+i*100,2024,$2 FROM generate_series(0,2) i`,
		fixtureBase, fixture.sourceFileID)
	exec(`
		INSERT INTO analytics.rental_facts(transaction_id,contract_date,dataset_year,property_group,space_count,area,
		  monthly_rent_reported,monthly_rent_ex_vat,monthly_rent_per_sqm,rent_derivation,rental_term,is_market_rent,
		  is_quality_eligible,representative_eligible,location,municipality_id,settlement_id,
		  cadastral_municipality_code,building_number)
		SELECT t.transaction_id,t.contract_date,2024,'apartment',1,50,t.contract_rent,t.contract_rent,t.contract_rent/50,
		  'homogeneous_transaction_rent','fixed',true,true,true,
		  ST_Transform(ST_SetSRID(ST_MakePoint(15.51,45.51),4326),3794),$2,$3,$4,'1'
		FROM rental_transactions t WHERE t.transaction_id BETWEEN $1::bigint+100 AND $1::bigint+102`,
		fixtureBase, fixture.municipalityID, fixture.settlementID, fixtureCadastralCode)
	exec(`
		INSERT INTO rental_building_parts(transaction_id,cadastral_municipality_code,building_number,building_part_number,
		  settlement,street,house_number,municipality_name,rented_spaces_area,centroid_e,centroid_n,
		  dataset_year,source_file_id,source_row_number)
		SELECT f.transaction_id,f.cadastral_municipality_code,'1','1','TESTNO NASELJE','TESTNA ULICA','5','TESTNA OBČINA',
		  50,ST_X(f.location),ST_Y(f.location),2024,$2,(f.transaction_id-$1::bigint)::int+1
		FROM analytics.rental_facts f WHERE f.transaction_id BETWEEN $1::bigint+100 AND $1::bigint+102`, fixtureBase, fixture.sourceFileID)
	return ctx, fixture
}

// asAPI switches the rest of the transaction to the API role, so the test also proves its grants.
func (fixture *repositoryFixture) asAPI(t *testing.T, ctx context.Context) {
	t.Helper()
	if _, err := fixture.tx.Exec(ctx, "SET LOCAL ROLE real_estate_api"); err != nil {
		t.Fatalf("set role: %v", err)
	}
}

func TestRecentTransactionsIntegration(t *testing.T) {
	ctx, fixture := newRepositoryFixture(t)
	fixture.asAPI(t, ctx)
	repository := NewStatisticsRepository(fixture.tx)
	filter := StatisticsFilter{GeographyID: &fixture.municipalityID}
	transactionIDs := func(items []RecentTransaction) []int64 {
		ids := make([]int64, len(items))
		for index, item := range items {
			ids[index] = item.TransactionID - fixtureBase
		}
		return ids
	}
	tests := []struct {
		name   string
		kind   string
		filter StatisticsFilter
		page   RecentPage
		want   []int64
		total  int
	}{
		{"newest first", "sale", filter, RecentPage{Limit: 10, Sort: "date", Descending: true}, []int64{4, 3, 2, 1, 0}, 5},
		{"oldest first", "sale", filter, RecentPage{Limit: 2, Sort: "date"}, []int64{0, 1}, 5},
		{"price descending", "sale", filter, RecentPage{Limit: 3, Sort: "price", Descending: true}, []int64{4, 2, 0}, 5},
		{"per square metre ascending", "sale", filter, RecentPage{Limit: 10, Sort: "perSqm"}, []int64{1, 3, 2, 0, 4}, 5},
		{"area descending, second page", "sale", filter, RecentPage{Limit: 2, Offset: 2, Sort: "area", Descending: true}, []int64{1, 0}, 5},
		{"street, case-insensitive", "sale", filter, RecentPage{Limit: 10, Sort: "date", Descending: true, Street: "testna ulica"}, []int64{3, 2, 1, 0}, 4},
		{"area filter", "sale", StatisticsFilter{GeographyID: &fixture.municipalityID, MinArea: floatPointer(60), MaxArea: floatPointer(90)},
			RecentPage{Limit: 10, Sort: "area"}, []int64{1, 4}, 2},
		{"past the end keeps the total", "sale", filter, RecentPage{Limit: 10, Offset: 50, Sort: "date"}, []int64{}, 5},
		{"rentals", "rent", StatisticsFilter{GeographyID: &fixture.settlementID}, RecentPage{Limit: 10, Sort: "price", Descending: true}, []int64{102, 101, 100}, 3},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			items, total, err := repository.RecentTransactions(ctx, test.kind, test.filter, test.page)
			if err != nil {
				t.Fatal(err)
			}
			if got := transactionIDs(items); total != test.total || !equalInt64s(got, test.want) {
				t.Fatalf("items=%v total=%d, want %v total=%d", got, total, test.want, test.total)
			}
		})
	}
	items, _, err := repository.RecentTransactions(ctx, "sale", filter, RecentPage{Limit: 1, Sort: "date"})
	if err != nil {
		t.Fatal(err)
	}
	first := items[0]
	if first.Street == nil || *first.Street != "TESTNA ULICA" || first.HouseNumber == nil || *first.HouseNumber != "5" ||
		first.SettlementName == nil || *first.SettlementName != "Testno naselje" || !first.Representative {
		t.Fatalf("address of the first agreement = %+v", first)
	}
	missing := int64(-1)
	if _, _, err := repository.RecentTransactions(ctx, "sale", StatisticsFilter{GeographyID: &missing}, RecentPage{Limit: 1}); err != ErrGeographyNotFound {
		t.Fatalf("unknown geography error=%v", err)
	}
}

func TestBuildingSummariesIntegration(t *testing.T) {
	ctx, fixture := newRepositoryFixture(t)
	fixture.asAPI(t, ctx)
	repository := NewStatisticsRepository(fixture.tx)
	bounds := Bounds{West: 15.50, South: 45.50, East: 15.52, North: 45.52}
	filter := StatisticsFilter{GeographyID: &fixture.municipalityID}
	items, err := repository.BuildingSummaries(ctx, filter, bounds, "sale", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].BuildingNumber != "1" || items[0].TransactionCount != 4 || items[0].RepresentativeCount != 3 {
		t.Fatalf("buildings=%+v", items)
	}
	// Representative only: 200000/50, 150000/60 and 300000/100 → median 3000.
	if items[0].MedianAmountPerSQM == nil || *items[0].MedianAmountPerSQM != 3000 {
		t.Fatalf("median=%v", items[0].MedianAmountPerSQM)
	}
	if items[0].Street == nil || *items[0].Street != "TESTNA ULICA" || items[0].ConstructionYear == nil || *items[0].ConstructionYear != 1990 {
		t.Fatalf("address/year=%+v", items[0])
	}
	if limited, err := repository.BuildingSummaries(ctx, filter, bounds, "sale", 1); err != nil || len(limited) != 1 {
		t.Fatalf("limit: %d items err=%v", len(limited), err)
	}
	rentals, err := repository.BuildingSummaries(ctx, filter, bounds, "rent", 10)
	if err != nil || len(rentals) != 1 || rentals[0].TransactionCount != 3 || rentals[0].MedianAmountPerSQM == nil || *rentals[0].MedianAmountPerSQM != 14 {
		t.Fatalf("rentals=%+v err=%v", rentals, err)
	}
	elsewhere, err := repository.BuildingSummaries(ctx, filter, Bounds{West: 14.0, South: 46.0, East: 14.1, North: 46.1}, "sale", 10)
	if err != nil || len(elsewhere) != 0 {
		t.Fatalf("outside the bounds: %+v err=%v", elsewhere, err)
	}
}

func TestMunicipalityMediansIntegration(t *testing.T) {
	ctx, fixture := newRepositoryFixture(t)
	fixture.asAPI(t, ctx)
	repository := NewStatisticsRepository(fixture.tx)
	from, to := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2024, 12, 31, 0, 0, 0, 0, time.UTC)
	medians, err := repository.MunicipalityMedians(ctx, StatisticsFilter{FromDate: &from, ToDate: &to, PropertyGroup: "apartment"})
	if err != nil {
		t.Fatal(err)
	}
	for _, median := range medians {
		if median.GeographyID == fixture.municipalityID {
			// Representative: 4000, 2500, 3000, 6250 → 3500.
			if median.RepresentativeCount != 4 || median.MedianPricePerSQM == nil || *median.MedianPricePerSQM != 3500 {
				t.Fatalf("median=%+v", median)
			}
			return
		}
	}
	t.Fatalf("fixture municipality missing from %d medians", len(medians))
}

func TestLoadAddressIndexIntegration(t *testing.T) {
	ctx, fixture := newRepositoryFixture(t)
	fixture.asAPI(t, ctx)
	index, err := loadAddressIndex(ctx, fixture.tx)
	if err != nil {
		t.Fatal(err)
	}
	plan := index.plan(parseAddressQuery("Testna ulica 5"), 5)
	if plan.matchType != SearchMatchAddress || len(plan.hits) == 0 {
		t.Fatalf("plan=%+v", plan)
	}
	building := index.buildings[plan.hits[0].building]
	if building.key.code != fixtureCadastralCode || building.key.number != "1" {
		t.Fatalf("building=%+v", building.key)
	}
	settlements := index.matchSettlements(parseAddressQuery("Testno nas"), 5)
	if len(settlements) == 0 || settlements[0].ID != fixture.settlementID || settlements[0].Municipality != "Testna občina" {
		t.Fatalf("settlements=%+v", settlements)
	}
}

func TestDataStatusIntegration(t *testing.T) {
	ctx, fixture := newRepositoryFixture(t)
	exec := func(sql string) {
		t.Helper()
		if _, err := fixture.tx.Exec(ctx, sql); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
	}
	exec(`INSERT INTO analytics.analytical_releases(id,status,stage,started_at,published_at)
		VALUES ('00000000-0000-4000-8000-000000000001','published','published',now()-interval '2 days',now()-interval '1 day')`)
	exec(`INSERT INTO analytics.analytical_releases(id,status,stage,started_at,failed_at,failure_message)
		VALUES ('00000000-0000-4000-8000-000000000002','failed','analytics',now()-interval '1 hour',now(),
		        'ERROR: relation "secret_table" does not exist at /srv/pipeline/sql.py')`)
	exec(`INSERT INTO analytics.analytical_publication(singleton,active_release_id,pending_release_id)
		VALUES (true,'00000000-0000-4000-8000-000000000001',NULL)
		ON CONFLICT (singleton) DO UPDATE SET active_release_id=EXCLUDED.active_release_id,pending_release_id=NULL`)
	fixture.asAPI(t, ctx)
	repository := NewStatisticsRepository(fixture.tx)
	status, err := repository.DataStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Active == nil || status.Active.ID != "00000000-0000-4000-8000-000000000001" ||
		status.LastFailed == nil || status.LastFailed.ID != "00000000-0000-4000-8000-000000000002" || status.Pending != nil {
		t.Fatalf("status=%+v", status)
	}
	body, _ := json.Marshal(status)
	if strings.Contains(string(body), "secret_table") || strings.Contains(string(body), "failureMessage") {
		t.Fatalf("public status exposes the failure message: %s", body)
	}
}

func equalInt64s(left, right []int64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
