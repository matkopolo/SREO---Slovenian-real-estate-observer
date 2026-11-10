package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
)

func (s *server) searchBuildings(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(query)) < 3 || len(query) > 120 {
		writeError(w, r, http.StatusBadRequest, "invalid_search",
			"q must contain between 3 and 120 characters")
		return
	}
	limit, ok := boundedInteger(w, r, "limit", 10, 1, 20)
	if !ok {
		return
	}
	filter, ok := parseBuildingFilter(w, r)
	if !ok {
		return
	}
	result, err := s.buildings.SearchBuildings(r.Context(), query, limit, filter)
	if err != nil {
		s.fail(w, r, "search buildings", err)
		return
	}
	if result.Items == nil {
		result.Items = []analytics.BuildingSearchResult{}
	}
	if result.Streets == nil {
		result.Streets = []analytics.StreetSearchResult{}
	}
	if result.Settlements == nil {
		result.Settlements = []analytics.SettlementSearchResult{}
	}
	if result.MatchType == "" {
		result.MatchType = analytics.SearchMatchNone
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"items": result.Items, "count": len(result.Items), "matchType": result.MatchType,
		"requestedHouseNumber": result.RequestedHouseNumber, "streets": result.Streets,
		"settlements": result.Settlements,
	})
}

func (s *server) buildingStatistics(w http.ResponseWriter, r *http.Request) {
	code64, err := strconv.ParseInt(r.PathValue("cadastralCode"), 10, 32)
	if err != nil || code64 <= 0 {
		writeError(w, r, http.StatusBadRequest, "invalid_cadastral_code",
			"cadastral code must be a positive integer")
		return
	}
	number := r.PathValue("buildingNumber")
	if number == "" || len(number) > 100 {
		writeError(w, r, http.StatusBadRequest, "invalid_building_number",
			"building number is required")
		return
	}
	filter, ok := parseBuildingFilter(w, r)
	if !ok {
		return
	}
	result, err := s.buildings.BuildingStatistics(
		r.Context(), int32(code64), number, filter)
	if err != nil {
		s.fail(w, r, "load building statistics", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func parseBuildingFilter(
	w http.ResponseWriter, r *http.Request,
) (analytics.BuildingFilter, bool) {
	var filter analytics.BuildingFilter
	var ok bool
	if filter.FromDate, filter.ToDate, ok = dateRange(w, r); !ok {
		return filter, false
	}
	filter.PropertyGroup = r.URL.Query().Get("propertyGroup")
	if filter.PropertyGroup != "" && !validPropertyGroup(filter.PropertyGroup) {
		writeError(w, r, http.StatusBadRequest, "invalid_property_group",
			"unsupported propertyGroup")
		return filter, false
	}
	return filter, true
}
