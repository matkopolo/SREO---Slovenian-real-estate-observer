package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/economics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
)

type fakeDatabase struct{ err error }

type fakeEconomics struct{ err, factorErr error }

func (store fakeEconomics) Inflation(
	context.Context, time.Time, time.Time, string,
) ([]economics.Point, error) {
	return []economics.Point{{Period: "2024-01-01", AnnualRatePercent: 3.2}}, store.err
}

func (store fakeEconomics) InflationFactor(_ context.Context, from, to time.Time) (economics.InflationFactor, error) {
	return economics.InflationFactor{From: from.Format("2006-01-02"), To: to.Format("2006-01-02"), Factor: 1.02, Months: 1}, store.factorErr
}

type fakeConstruction struct{ err error }

func (store fakeConstruction) Summary(context.Context, construction.Filter) (construction.Summary, error) {
	return construction.Summary{BuildingsByYear: []construction.YearCount{}, Permits: []construction.PermitYear{}}, store.err
}

func (store fakeConstruction) MapFeatures(context.Context, construction.Filter, bool) ([]construction.MapFeature, bool, error) {
	return []construction.MapFeature{}, false, store.err
}

func (store fakeConstruction) Building(context.Context, string) (construction.Building, error) {
	return construction.Building{EID: "1"}, store.err
}

func (database fakeDatabase) Ping(context.Context) error { return database.err }

type fakeGeographies struct {
	units []geography.Unit
	err   error
}

type fakeStatistics struct {
	overview analytics.Overview
	points   []analytics.TimeSeriesPoint
	medians  []analytics.GeographyMedian
	err      error
}

func (store fakeStatistics) MunicipalityMedians(context.Context, analytics.StatisticsFilter) ([]analytics.GeographyMedian, error) {
	return store.medians, store.err
}

type fakeMaps struct{}
type fakeTransactions struct{ err error }
type fakeDistributions struct{ err error }
type fakeBuildings struct{ err error }
type fakeAnomalies struct{ err error }
type fakeModels struct{ err error }
type fakeReleases struct {
	status analytics.DataStatus
	err    error
}

func (store fakeReleases) DataStatus(context.Context) (analytics.DataStatus, error) {
	return store.status, store.err
}

func (store fakeModels) MarketIndices(context.Context, analytics.MarketIndexFilter) ([]analytics.MarketIndexPoint, error) {
	return []analytics.MarketIndexPoint{{TransactionKind: "sale", Method: "hedonic"}}, store.err
}

func (store fakeModels) ValuationPrediction(context.Context, string, int64) (analytics.ValuationPrediction, error) {
	return analytics.ValuationPrediction{TransactionKind: "sale", TransactionID: -1}, store.err
}

func (store fakeAnomalies) Anomalies(
	context.Context,
	analytics.AnomalyFilter,
	int,
	int,
) ([]analytics.AnomalySignal, int64, error) {
	return []analytics.AnomalySignal{{TransactionKind: "sale", TransactionID: -1}}, 1, store.err
}

func (store fakeAnomalies) AnomalySummary(context.Context, string) (analytics.AnomalySummary, error) {
	return analytics.AnomalySummary{Total: 10, Flagged: 2}, store.err
}

func (store fakeBuildings) BuildingStatistics(
	context.Context, int32, string, analytics.BuildingFilter,
) (analytics.BuildingStatistics, error) {
	return analytics.BuildingStatistics{
		CadastralMunicipalityCode: 657,
		BuildingNumber:            "123",
	}, store.err
}

func (store fakeBuildings) SearchBuildings(
	context.Context, string, int, analytics.BuildingFilter,
) (analytics.BuildingSearch, error) {
	street, houseNumber := "LACKOVA CESTA", "13"
	return analytics.BuildingSearch{MatchType: analytics.SearchMatchAddress, Items: []analytics.BuildingSearchResult{{
		CadastralMunicipalityCode: 678,
		BuildingNumber:            "2952",
		Street:                    &street,
		HouseNumber:               &houseNumber,
		Longitude:                 15.61,
		Latitude:                  46.53,
		SaleCount:                 2,
	}}}, store.err
}

func (store fakeDistributions) SaleDistribution(
	context.Context,
	analytics.StatisticsFilter,
	string,
	int,
) (analytics.Distribution, error) {
	return analytics.Distribution{Metric: "pricePerSqm", SampleSize: 10}, store.err
}

func (store fakeDistributions) RentalDistribution(
	context.Context,
	analytics.StatisticsFilter,
	string,
	int,
) (analytics.Distribution, error) {
	return analytics.Distribution{Metric: "rentPerSqm", SampleSize: 10}, store.err
}

func (store fakeTransactions) SaleTransaction(context.Context, int64) (analytics.SaleTransactionDetail, error) {
	return analytics.SaleTransactionDetail{TransactionID: 1, PropertyGroup: "apartment"}, store.err
}

func (store fakeTransactions) RentalTransaction(context.Context, int64) (analytics.RentalTransactionDetail, error) {
	return analytics.RentalTransactionDetail{TransactionID: 1, PropertyGroup: "apartment"}, store.err
}

func (store fakeTransactions) TransactionContext(
	context.Context, string, int64,
) (analytics.TransactionContext, error) {
	return analytics.TransactionContext{
		TransactionKind: "sale", TransactionID: 1,
		PropertyGroup: "apartment", DirectComparables: []analytics.DirectComparable{},
		Benchmarks: []analytics.ContextBenchmark{},
	}, store.err
}

func (fakeMaps) Clusters(
	context.Context,
	analytics.StatisticsFilter,
	analytics.Bounds,
	float64,
) ([]analytics.Cluster, error) {
	return []analytics.Cluster{{Longitude: 15.6, Latitude: 46.5, TransactionCount: 10}}, nil
}

func (fakeMaps) PropertyPoints(
	context.Context,
	analytics.StatisticsFilter,
	analytics.Bounds,
	int,
) ([]analytics.PropertyPoint, error) {
	return []analytics.PropertyPoint{{
		TransactionID: 1,
		Longitude:     15.6,
		Latitude:      46.5,
		PropertyGroup: "apartment",
	}}, nil
}

func (fakeMaps) GeographySummaries(
	context.Context,
	analytics.StatisticsFilter,
	analytics.Bounds,
	string,
	string,
) ([]analytics.GeographySummary, error) {
	return []analytics.GeographySummary{{
		GeographyID: 1, Level: "country", Name: "Slovenija",
		Longitude: 14.8, Latitude: 46.1, Bounds: []float64{13.3, 45.4, 16.7, 46.9},
		TransactionCount: 10,
	}}, nil
}

func (fakeMaps) BuildingSummaries(
	_ context.Context, _ analytics.StatisticsFilter, _ analytics.Bounds, kind string, limit int,
) ([]analytics.BuildingSummary, error) {
	median := 3100.0
	if kind == "rent" {
		median = 12.5
	}
	items := []analytics.BuildingSummary{
		{CadastralMunicipalityCode: 1737, BuildingNumber: "1512", Longitude: 14.5, Latitude: 46.05,
			TransactionCount: 7, RepresentativeCount: 6, MedianAmountPerSQM: &median},
		{CadastralMunicipalityCode: 1737, BuildingNumber: "88", Longitude: 14.51, Latitude: 46.06, TransactionCount: 2},
	}
	if limit < len(items) {
		items = items[:limit]
	}
	return items, nil
}

func (store fakeStatistics) Overview(
	context.Context,
	analytics.StatisticsFilter,
) (analytics.Overview, error) {
	return store.overview, store.err
}

func (store fakeStatistics) TimeSeries(
	context.Context,
	analytics.StatisticsFilter,
	string,
) ([]analytics.TimeSeriesPoint, error) {
	return store.points, store.err
}

func (store fakeStatistics) Outliers(
	context.Context,
	analytics.StatisticsFilter,
	int,
	int,
) ([]analytics.OutlierRecord, int64, error) {
	return []analytics.OutlierRecord{{TransactionID: 1, PropertyGroup: "apartment"}}, 1, store.err
}

func (store fakeStatistics) TransactionExtremes(
	context.Context,
	string,
	analytics.StatisticsFilter,
	int,
) ([]analytics.TransactionExtreme, error) {
	return []analytics.TransactionExtreme{{
		Direction: "highest", TransactionID: 1, PropertyGroup: "apartment",
		AmountPerSQM: 5000,
	}}, store.err
}

func (store fakeStatistics) RentalOverview(
	context.Context,
	analytics.StatisticsFilter,
) (analytics.RentalOverview, error) {
	return analytics.RentalOverview{TransactionCount: 10, IncludedSampleSize: 8}, store.err
}

func (store fakeStatistics) RentalTimeSeries(
	context.Context,
	analytics.StatisticsFilter,
	string,
) ([]analytics.RentalTimeSeriesPoint, error) {
	return []analytics.RentalTimeSeriesPoint{{Period: "2024-01-01", TransactionCount: 10}}, store.err
}

func (store fakeStatistics) RentalOutliers(
	context.Context,
	analytics.StatisticsFilter,
	int,
	int,
) ([]analytics.RentalOutlierRecord, int64, error) {
	return []analytics.RentalOutlierRecord{{TransactionID: 1, PropertyGroup: "apartment"}}, 1, store.err
}

func (store fakeStatistics) RentalClusters(
	context.Context,
	analytics.StatisticsFilter,
	analytics.Bounds,
	float64,
) ([]analytics.Cluster, error) {
	return []analytics.Cluster{{Longitude: 15.6, Latitude: 46.5}}, store.err
}

func (store fakeStatistics) RentalPropertyPoints(
	context.Context,
	analytics.StatisticsFilter,
	analytics.Bounds,
	int,
) ([]analytics.RentalPropertyPoint, error) {
	return []analytics.RentalPropertyPoint{{TransactionID: 1, Longitude: 15.6, Latitude: 46.5}}, store.err
}

func (store fakeGeographies) List(context.Context, geography.Filter) ([]geography.Unit, error) {
	return store.units, store.err
}

func (store fakeGeographies) Get(context.Context, int64) (geography.Unit, error) {
	if store.err != nil {
		return geography.Unit{}, store.err
	}
	return store.units[0], nil
}

func (store fakeGeographies) Boundaries(context.Context, string, float64, *[4]float64) ([]geography.Boundary, error) {
	boundaries := make([]geography.Boundary, 0, len(store.units))
	for _, unit := range store.units {
		boundaries = append(boundaries, geography.Boundary{Unit: unit, Geometry: []byte(`{"type":"Point","coordinates":[15,46]}`)})
	}
	return boundaries, store.err
}

func (store fakeGeographies) Lineage(context.Context, int64) ([]geography.Unit, error) {
	if store.err != nil {
		return nil, store.err
	}
	if len(store.units) == 0 {
		return nil, geography.ErrNotFound
	}
	return store.units[:1], nil
}

func (store fakeGeographies) Children(context.Context, int64) ([]geography.Unit, error) {
	return store.units, store.err
}

func (store fakeGeographies) Boundary(context.Context, int64, float64) (geography.Boundary, error) {
	if store.err != nil {
		return geography.Boundary{}, store.err
	}
	return geography.Boundary{
		Unit:     store.units[0],
		Geometry: []byte(`{"type":"Polygon","coordinates":[]}`),
	}, nil
}

// testDependencies returns a complete set of fakes; tests override what they exercise.
func testDependencies() Dependencies {
	return Dependencies{
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Database:    fakeDatabase{},
		Geographies: fakeGeographies{},
		Statistics: fakeStatistics{
			overview: analytics.Overview{TransactionCount: 10, EligibleCount: 8},
			points:   []analytics.TimeSeriesPoint{{Period: "2024-01-01", TransactionCount: 10}},
		},
		Rentals:          fakeStatistics{},
		Transactions:     fakeTransactions{},
		Histories:        fakeHistory{},
		Distributions:    fakeDistributions{},
		Buildings:        fakeBuildings{},
		Anomalies:        fakeAnomalies{},
		Models:           fakeModels{},
		Releases:         fakeReleases{status: analytics.DataStatus{Status: "current"}},
		Maps:             fakeMaps{},
		Economics:        fakeEconomics{},
		Affordability:    fakeAffordability{},
		Construction:     fakeConstruction{},
		Demography:       fakeDemography{},
		Recent:           fakeRecent{},
		ApplicationName:  "test-api",
		ApplicationBuild: "test",
		Environment:      "test",
	}
}

// handlerWith builds the API from testDependencies changed by override.
func handlerWith(override func(*Dependencies)) http.Handler {
	dependencies := testDependencies()
	if override != nil {
		override(&dependencies)
	}
	handler, err := New(dependencies)
	if err != nil {
		panic(err)
	}
	return handler
}

func newTestHandler(databaseError error, store fakeGeographies) http.Handler {
	return handlerWith(func(d *Dependencies) {
		d.Database = fakeDatabase{err: databaseError}
		d.Geographies = store
	})
}

var errTestDatabase = errors.New("database unavailable")
