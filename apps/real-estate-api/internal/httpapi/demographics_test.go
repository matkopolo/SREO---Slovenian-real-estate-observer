package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/demography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
)

type fakeDemography struct{ err error }

func (store fakeDemography) Profile(_ context.Context, id *int64) (demography.Profile, error) {
	if store.err != nil {
		return demography.Profile{}, store.err
	}
	unit := demography.Unit{ID: 1, Level: "country", Name: "Slovenija"}
	if id != nil {
		unit = demography.Unit{ID: *id, Level: "municipality", Name: "Maribor"}
	}
	return demography.Profile{Geography: unit, Period: "2026H1", Population: demography.Population{Total: 2135107}}, nil
}

func (store fakeDemography) Municipalities(context.Context) ([]demography.Summary, error) {
	return []demography.Summary{{GeographyID: 70, Name: "Maribor", Population: 113000}}, store.err
}

func getJSON(t *testing.T, handler http.Handler, path string) (int, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	body := map[string]any{}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return recorder.Code, body
}

func TestDemographicsProfileStatuses(t *testing.T) {
	handler := handlerWith(nil)
	status, body := getJSON(t, handler, "/api/v1/demographics")
	if status != http.StatusOK || body["profile"].(map[string]any)["geography"].(map[string]any)["name"] != "Slovenija" {
		t.Fatalf("national profile %d %v", status, body)
	}
	if len(body["sources"].([]any)) == 0 || body["releasesCaveat"] == "" {
		t.Fatalf("sources and caveat must be present: %v", body)
	}
	if status, _ := getJSON(t, handler, "/api/v1/demographics?geographyId=0"); status != http.StatusBadRequest {
		t.Fatalf("invalid id status %d", status)
	}
	cases := map[error]int{demography.ErrNotFound: 404, demography.ErrUnsupportedLevel: 400, demography.ErrUnavailable: 503}
	for err, want := range cases {
		failing := handlerWith(func(d *Dependencies) { d.Demography = fakeDemography{err: err} })
		if status, _ := getJSON(t, failing, "/api/v1/demographics?geographyId=5"); status != want {
			t.Fatalf("%v status %d, want %d", err, status, want)
		}
	}
	status, body = getJSON(t, handler, "/api/v1/demographics/municipalities")
	if status != http.StatusOK || len(body["items"].([]any)) != 1 {
		t.Fatalf("municipalities %d %v", status, body)
	}
}

func TestMapBuildingsAggregatesByBuilding(t *testing.T) {
	handler := handlerWith(nil)
	status, body := getJSON(t, handler, "/api/v1/map/buildings?bbox=14.4,46.0,14.6,46.1&limit=1")
	if status != http.StatusOK || body["truncated"] != true || body["transactionKind"] != "sale" {
		t.Fatalf("buildings %d %v", status, body)
	}
	item := body["items"].([]any)[0].(map[string]any)
	if item["transactionCount"].(float64) != 7 || item["medianAmountPerSqm"].(float64) != 3100 {
		t.Fatalf("item %v", item)
	}
	status, body = getJSON(t, handler, "/api/v1/map/buildings?bbox=14.4,46.0,14.6,46.1&transactionKind=rent")
	if status != http.StatusOK || body["truncated"] != false || body["items"].([]any)[0].(map[string]any)["medianAmountPerSqm"].(float64) != 12.5 {
		t.Fatalf("rent buildings %d %v", status, body)
	}
	for _, query := range []string{"?bbox=14.4,46.0,14.6,46.1&transactionKind=lease", "?bbox=14.4,46.0,14.6,46.1&limit=9000", ""} {
		if status, _ := getJSON(t, handler, "/api/v1/map/buildings"+query); status != http.StatusBadRequest {
			t.Fatalf("%q status %d, want 400", query, status)
		}
	}
}

type fakeRecent struct{}

func (fakeRecent) RecentTransactions(_ context.Context, kind string, filter analytics.StatisticsFilter, page analytics.RecentPage) ([]analytics.RecentTransaction, int, error) {
	if filter.GeographyID != nil && *filter.GeographyID == 404 {
		return nil, 0, analytics.ErrGeographyNotFound
	}
	street := "Slovenska cesta"
	return []analytics.RecentTransaction{{TransactionID: 9, PropertyGroup: "apartment", Street: &street, Representative: kind == "sale"}}[:min(1, page.Limit)], 1, nil
}

func TestRecentTransactionsListsNewestWithAddress(t *testing.T) {
	handler := handlerWith(nil)
	status, body := getJSON(t, handler, "/api/v1/transactions/recent?geographyId=133&limit=5")
	if status != http.StatusOK || body["transactionKind"] != "sale" {
		t.Fatalf("recent %d %v", status, body)
	}
	if body["items"].([]any)[0].(map[string]any)["street"] != "Slovenska cesta" {
		t.Fatalf("address missing: %v", body)
	}
	for query, want := range map[string]int{"?transactionKind=lease": 400, "?limit=999": 400, "?sort=floor": 400, "?order=up": 400, "?offset=-1": 400, "?geographyId=404": 404} {
		if status, _ := getJSON(t, handler, "/api/v1/transactions/recent"+query); status != want {
			t.Fatalf("%s status %d, want %d", query, status, want)
		}
	}
}

func TestFineBoundariesRequireABoundingBox(t *testing.T) {
	code := int32(301)
	handler := handlerWith(func(d *Dependencies) {
		d.Geographies = fakeGeographies{units: []geography.Unit{{ID: 266, Level: "city_district", Code: &code, Name: "Četrtna skupnost Bežigrad"}}}
	})
	if status, _ := getJSON(t, handler, "/api/v1/geographies/boundaries?level=city_district&detail=low"); status != http.StatusBadRequest {
		t.Fatalf("district boundaries without bbox: %d, want 400", status)
	}
	status, body := getJSON(t, handler, "/api/v1/geographies/boundaries?level=city_district&detail=low&bbox=14.4,45.98,14.62,46.12")
	if status != http.StatusOK || body["count"].(float64) != 1 {
		t.Fatalf("district boundaries with bbox: %d %v", status, body)
	}
	if status, _ := getJSON(t, handler, "/api/v1/geographies/boundaries?level=street"); status != http.StatusBadRequest {
		t.Fatalf("unknown level %d", status)
	}
}
