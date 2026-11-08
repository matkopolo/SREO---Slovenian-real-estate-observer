package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/affordability"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
)

// wageBands maps stored SURS series to the income bands shown, lowest first.
var wageBands = []struct{ id, series string }{
	{"p10", "net_wage_p10"}, {"q1", "net_wage_q1"}, {"p50", "net_wage_p50"},
	{"mean", "net_wage_mean"}, {"q3", "net_wage_q3"}, {"p90", "net_wage_p90"},
}

func (s *server) affordability(w http.ResponseWriter, r *http.Request) {
	if s.affordabilityStore == nil {
		writeError(w, r, http.StatusServiceUnavailable, "affordability_unavailable", "affordability context is not configured")
		return
	}
	query := r.URL.Query()
	propertyGroup := query.Get("propertyGroup")
	if propertyGroup == "" {
		propertyGroup = "apartment"
	}
	if propertyGroup != "apartment" && propertyGroup != "house" {
		writeError(w, r, http.StatusBadRequest, "invalid_property_group", "propertyGroup must be apartment or house")
		return
	}
	var geographyID *int64
	if raw := query.Get("geographyId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, r, http.StatusBadRequest, "invalid_geography_id", "geographyId must be a positive integer")
			return
		}
		geographyID = &id
	}

	ctx := r.Context()
	wageGeography, wageName, err := s.wageGeography(ctx, geographyID)
	if errors.Is(err, geography.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "geography_not_found", "geography was not found")
		return
	}
	if err != nil {
		s.logger.Error("affordability geography", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not resolve geography")
		return
	}
	wages, err := s.affordabilityStore.Wages(ctx, wageGeography)
	wageFallback := false
	if err == nil && len(wages) == 0 && wageGeography != "SI" {
		wages, err = s.affordabilityStore.Wages(ctx, "SI")
		wageGeography, wageName, wageFallback = "SI", "Slovenija", true
	}
	rule, ruleErr := s.affordabilityStore.Rule(ctx, time.Now())
	fixed, fixedErr := s.affordabilityStore.Latest(ctx, "housing_rate_fixed_10y")
	variable, variableErr := s.affordabilityStore.Latest(ctx, "housing_rate_variable")
	if err = errors.Join(err, ruleErr, fixedErr, variableErr); err != nil || len(wages) == 0 {
		if err != nil && !errors.Is(err, affordability.ErrUnavailable) {
			s.logger.Error("affordability context", "error", err)
		}
		writeError(w, r, http.StatusServiceUnavailable, "affordability_unavailable",
			"official wage, rate or lending-rule data has not been synchronised yet")
		return
	}
	aprc, _ := s.affordabilityStore.Latest(ctx, "housing_rate_aprc")
	euribor, _ := s.affordabilityStore.Latest(ctx, "euribor_6m")

	byID := map[string]affordability.Observation{}
	for _, item := range wages {
		byID[item.Series] = item
	}
	bands := make([]affordability.Band, 0, len(wageBands))
	for _, band := range wageBands {
		if item, ok := byID[band.series]; ok {
			bands = append(bands, affordability.Band{ID: band.id, Income: item.Value})
		}
	}
	sort.SliceStable(bands, func(i, j int) bool { return bands[i].Income < bands[j].Income })

	// Local median of the latest complete calendar year, same representative population
	// and publication rules as the market overview.
	year := time.Now().Year() - 1
	from := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(year, 12, 31, 0, 0, 0, 0, time.UTC)
	overview, err := s.statistics.Overview(ctx, analytics.StatisticsFilter{
		FromDate: &from, ToDate: &to, PropertyGroup: propertyGroup, GeographyID: geographyID,
	})
	if err != nil && !errors.Is(err, analytics.ErrGeographyNotFound) {
		s.logger.Error("affordability median", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not calculate the local median")
		return
	}
	var median *float64
	if overview.IsPublishable {
		median = overview.MedianPricePerSQM
	}
	wagePeriod := wages[0].Period
	writeJSON(w, http.StatusOK, map[string]any{
		"wageGeography":      map[string]any{"key": wageGeography, "name": wageName, "nationalFallback": wageFallback},
		"wagePeriod":         wagePeriod,
		"wageSource":         wages[0].SourceTable,
		"rule":               rule,
		"rates":              map[string]any{"fixedOver10Years": fixed, "variable": variable, "aprc": nullable(aprc), "euribor6m": nullable(euribor)},
		"stressMarginPoints": affordability.StressMarginPoints,
		"market": map[string]any{
			"propertyGroup": propertyGroup, "year": year, "medianPricePerSqm": median,
			"sampleSize": overview.IncludedSampleSize, "isPublishable": overview.IsPublishable,
		},
		"rows":       affordability.Compute(bands, rule, affordability.Rates{Fixed: fixed.Value, Variable: variable.Value}, median),
		"disclaimer": "Statistična ponazoritev, ne ponudba kredita ali osebna ocena kreditne sposobnosti.",
	})
}

func nullable(observation affordability.Observation) *affordability.Observation {
	if observation.Series == "" {
		return nil
	}
	return &observation
}

// wageGeography maps a selected area to the SURS geography of the wage distribution:
// its municipality (any level at or below one), otherwise Slovenia.
func (s *server) wageGeography(ctx context.Context, id *int64) (string, string, error) {
	if id == nil {
		return "SI", "Slovenija", nil
	}
	current := *id
	for depth := 0; depth < 8; depth++ {
		unit, err := s.geographies.Get(ctx, current)
		if err != nil {
			return "", "", err
		}
		if unit.Level == "municipality" && unit.Code != nil {
			return fmt.Sprintf("municipality:%d", *unit.Code), unit.Name, nil
		}
		if unit.ParentID == nil || unit.Level == "statistical_region" || unit.Level == "country" {
			return "SI", "Slovenija", nil
		}
		current = *unit.ParentID
	}
	return "SI", "Slovenija", nil
}
