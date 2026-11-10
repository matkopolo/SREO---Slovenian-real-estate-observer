package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSearchBuildingsReturnsMatchTypeAndStreets(t *testing.T) {
	response := httptest.NewRecorder()
	newTestHandler(nil, fakeGeographies{}).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/v1/buildings/search?q=Lackova+cesta+13", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var body struct {
		Items     []map[string]any `json:"items"`
		Count     int              `json:"count"`
		MatchType string           `json:"matchType"`
		Streets   []map[string]any `json:"streets"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Count != 1 || len(body.Items) != 1 || body.MatchType != "address" || body.Streets == nil {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestSearchBuildingsValidatesQuery(t *testing.T) {
	response := httptest.NewRecorder()
	newTestHandler(nil, fakeGeographies{}).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/v1/buildings/search?q=ab", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
}
