package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/affordability"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
)

type fakeAffordability struct {
	wages map[string][]affordability.Observation
	empty bool
}

func (f fakeAffordability) Rule(context.Context, time.Time) (affordability.Rule, error) {
	if f.empty {
		return affordability.Rule{}, affordability.ErrUnavailable
	}
	return affordability.Rule{ValidFrom: "2026-01-01", DSTIMax: 0.5, MinRemainingIncome: 745, RecommendedLTV: 0.8}, nil
}

func (f fakeAffordability) Wages(_ context.Context, key string) ([]affordability.Observation, error) {
	return f.wages[key], nil
}

func (f fakeAffordability) Latest(_ context.Context, series string) (affordability.Observation, error) {
	values := map[string]float64{"housing_rate_fixed_10y": 3.27, "housing_rate_variable": 3.47}
	value, ok := values[series]
	if !ok || f.empty {
		return affordability.Observation{}, affordability.ErrUnavailable
	}
	return affordability.Observation{Series: series, Period: "2026M09", Value: value, SourceTable: "Banka Slovenije I2_4_3AS"}, nil
}

func wageSet(median float64) []affordability.Observation {
	return []affordability.Observation{
		{Series: "net_wage_p50", Period: "2025M10", Value: median, SourceTable: "SURS 0711357S"},
		{Series: "net_wage_p90", Period: "2025M10", Value: 2518.48, SourceTable: "SURS 0711357S"},
	}
}

func affordabilityHandler(store affordability.Store, code int32, median *float64) http.Handler {
	return New(Dependencies{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Geographies: fakeGeographies{units: []geography.Unit{
			{ID: 70, Level: "municipality", Code: &code, Name: "Maribor"},
		}},
		Statistics:    fakeStatistics{overview: analytics.Overview{MedianPricePerSQM: median, IsPublishable: median != nil, IncludedSampleSize: 812}},
		Affordability: store,
	})
}

func getAffordability(t *testing.T, handler http.Handler, query string) (int, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/affordability"+query, nil))
	var body map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return recorder.Code, body
}

func TestAffordabilityUsesTheMunicipalityWageDistribution(t *testing.T) {
	median := 2500.0
	store := fakeAffordability{wages: map[string][]affordability.Observation{"municipality:70": wageSet(1326.4), "SI": wageSet(1379.49)}}
	status, body := getAffordability(t, affordabilityHandler(store, 70, &median), "?geographyId=70")
	if status != http.StatusOK {
		t.Fatalf("status %d: %v", status, body)
	}
	wage := body["wageGeography"].(map[string]any)
	if wage["key"] != "municipality:70" || wage["nationalFallback"] != false {
		t.Fatalf("unexpected wage geography %v", wage)
	}
	rows := body["rows"].([]any)
	first := rows[0].(map[string]any)
	if first["band"].(map[string]any)["id"] != "p50" || first["floorBinding"] != true || first["affordableSqm"] == nil {
		t.Fatalf("unexpected first row %v", first)
	}
	if body["market"].(map[string]any)["sampleSize"].(float64) != 812 {
		t.Fatalf("market sample missing: %v", body["market"])
	}
}

func TestAffordabilityFallsBackToNationalWagesAndKeepsSuppressedMedian(t *testing.T) {
	store := fakeAffordability{wages: map[string][]affordability.Observation{"SI": wageSet(1379.49)}}
	status, body := getAffordability(t, affordabilityHandler(store, 999, nil), "?geographyId=70")
	if status != http.StatusOK {
		t.Fatalf("status %d: %v", status, body)
	}
	if body["wageGeography"].(map[string]any)["nationalFallback"] != true {
		t.Fatalf("expected national fallback: %v", body["wageGeography"])
	}
	if row := body["rows"].([]any)[0].(map[string]any); row["affordableSqm"] != nil {
		t.Fatalf("suppressed median must not produce an area: %v", row)
	}
}

func TestAffordabilityReportsMissingContextAndValidatesInput(t *testing.T) {
	if status, _ := getAffordability(t, affordabilityHandler(fakeAffordability{empty: true}, 70, nil), ""); status != http.StatusServiceUnavailable {
		t.Fatalf("missing context status = %d, want 503", status)
	}
	store := fakeAffordability{wages: map[string][]affordability.Observation{"SI": wageSet(1379.49)}}
	if status, _ := getAffordability(t, affordabilityHandler(store, 70, nil), "?propertyGroup=land"); status != http.StatusBadRequest {
		t.Fatalf("land status = %d, want 400", status)
	}
	if status, _ := getAffordability(t, affordabilityHandler(store, 70, nil), "?geographyId=x"); status != http.StatusBadRequest {
		t.Fatalf("bad id status = %d, want 400", status)
	}
}
