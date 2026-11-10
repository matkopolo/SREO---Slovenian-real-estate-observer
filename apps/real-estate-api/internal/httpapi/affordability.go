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
	query := r.URL.Query()
	propertyGroup := query.Get("propertyGroup")
	if propertyGroup == "" {
		propertyGroup = "apartment"
	}
	if propertyGroup != "apartment" && propertyGroup != "house" {
		writeError(w, r, http.StatusBadRequest, "invalid_property_group", "propertyGroup must be apartment or house")
		return
	}
	geographyID, ok := optionalGeographyID(w, r)
	if !ok {
		return
	}

	household := []float64{}
	for _, name := range []string{"netIncome", "coBorrowerIncome"} {
		raw := query.Get(name)
		if raw == "" {
			continue
		}
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil || value <= 0 || value > 100000 {
			writeError(w, r, http.StatusBadRequest, "invalid_income", name+" must be a net monthly income between 0 and 100000 EUR")
			return
		}
		household = append(household, value)
	}
	if query.Get("coBorrowerIncome") != "" && query.Get("netIncome") == "" {
		writeError(w, r, http.StatusBadRequest, "invalid_income", "coBorrowerIncome requires netIncome")
		return
	}

	ctx := r.Context()
	now := s.now()
	wageGeography, wageName, err := s.wageGeography(ctx, geographyID)
	if err != nil {
		s.fail(w, r, "resolve geography", err)
		return
	}
	wages, err := s.affordabilityStore.Wages(ctx, wageGeography)
	// A region (or anything above a municipality) uses Slovenian wages: say so.
	wageFallback := geographyID != nil && wageGeography == "SI"
	if err == nil && len(wages) == 0 && wageGeography != "SI" {
		wages, err = s.affordabilityStore.Wages(ctx, "SI")
		wageGeography, wageName, wageFallback = "SI", "Slovenija", true
	}
	rule, ruleErr := s.affordabilityStore.Rule(ctx, now)
	fixed, fixedErr := s.affordabilityStore.Latest(ctx, "housing_rate_fixed_10y")
	variable, variableErr := s.affordabilityStore.Latest(ctx, "housing_rate_variable")
	if err = errors.Join(err, ruleErr, fixedErr, variableErr); err != nil || len(wages) == 0 {
		s.affordabilityUnavailable(w, r, err)
		return
	}
	// Optional context: shown when stored, never required.
	aprc := s.optionalObservation(r, "housing_rate_aprc")
	euribor := s.optionalObservation(r, "euribor_6m")

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
	year := now.Year() - 1
	from := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(year, 12, 31, 0, 0, 0, 0, time.UTC)
	overview, err := s.statistics.Overview(ctx, analytics.StatisticsFilter{
		FromDate: &from, ToDate: &to, PropertyGroup: propertyGroup, GeographyID: geographyID,
	})
	if err != nil && !errors.Is(err, analytics.ErrGeographyNotFound) {
		s.fail(w, r, "calculate the local median", err)
		return
	}
	var median *float64
	if overview.IsPublishable {
		median = overview.MedianPricePerSQM
	}
	wagePeriod := wages[0].Period
	rates := affordability.Rates{Fixed: fixed.Value, Variable: variable.Value}
	var custom any
	if len(household) > 0 {
		custom = affordability.Household(household, rule, rates)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"household":          custom,
		"wageGeography":      map[string]any{"key": wageGeography, "name": wageName, "nationalFallback": wageFallback},
		"wagePeriod":         wagePeriod,
		"wageSource":         wages[0].SourceTable,
		"rule":               rule,
		"rates":              map[string]any{"fixedOver10Years": fixed, "variable": variable, "aprc": aprc, "euribor6m": euribor},
		"stressMarginPoints": affordability.StressMarginPoints,
		"market": map[string]any{
			"propertyGroup": propertyGroup, "year": year, "medianPricePerSqm": median,
			"sampleSize": overview.IncludedSampleSize, "isPublishable": overview.IsPublishable,
		},
		"rows":       affordability.Compute(bands, rule, rates, median),
		"disclaimer": "Statistična ponazoritev, ne ponudba kredita ali osebna ocena kreditne sposobnosti.",
	})
}

// affordabilityUnavailable answers when wages, rates or the lending rule are missing; only
// unexpected errors are logged.
func (s *server) affordabilityUnavailable(w http.ResponseWriter, r *http.Request, err error) {
	if err != nil && !errors.Is(err, affordability.ErrUnavailable) {
		s.fail(w, r, "load the affordability context", err)
		return
	}
	writeError(w, r, http.StatusServiceUnavailable, "affordability_unavailable",
		"official wage, rate or lending-rule data has not been synchronised yet")
}

// optionalObservation returns the latest value of an optional national series, or nil.
func (s *server) optionalObservation(r *http.Request, series string) *affordability.Observation {
	observation, err := s.affordabilityStore.Latest(r.Context(), series)
	if err != nil {
		if !errors.Is(err, affordability.ErrUnavailable) {
			requestLog(r).Warn("optional affordability series", "series", series, "error", err)
		}
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
	lineage, err := s.geographies.Lineage(ctx, *id)
	if err != nil {
		return "", "", err
	}
	for _, unit := range lineage {
		if unit.Level == "municipality" && unit.Code != nil {
			return fmt.Sprintf("municipality:%d", *unit.Code), unit.Name, nil
		}
		if unit.Level == "statistical_region" || unit.Level == "country" {
			break
		}
	}
	return "SI", "Slovenija", nil
}

// affordabilityMunicipalities returns the median earner's illustrative capacity for every
// municipality in one response: SURS wages by municipality of residence and the municipality's
// ETN median EUR/m2 pooled over fromYear–toYear (one summary query for all municipalities).
func (s *server) affordabilityMunicipalities(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	propertyGroup := query.Get("propertyGroup")
	if propertyGroup == "" {
		propertyGroup = "apartment"
	}
	if propertyGroup != "apartment" && propertyGroup != "house" {
		writeError(w, r, http.StatusBadRequest, "invalid_property_group", "propertyGroup must be apartment or house")
		return
	}
	now := s.now()
	last := now.Year() - 1
	toYear, ok := boundedInteger(w, r, "toYear", last, 2007, last)
	if !ok {
		return
	}
	fromYear, ok := boundedInteger(w, r, "fromYear", toYear-2, 2007, toYear)
	if !ok {
		return
	}
	ctx := r.Context()
	rule, ruleErr := s.affordabilityStore.Rule(ctx, now)
	fixed, fixedErr := s.affordabilityStore.Latest(ctx, "housing_rate_fixed_10y")
	variable, variableErr := s.affordabilityStore.Latest(ctx, "housing_rate_variable")
	wages, wagesErr := s.affordabilityStore.AllWages(ctx)
	if err := errors.Join(ruleErr, fixedErr, variableErr, wagesErr); err != nil || len(wages) == 0 {
		s.affordabilityUnavailable(w, r, err)
		return
	}
	units, err := s.geographies.List(ctx, geography.Filter{Level: "municipality"})
	if err != nil {
		s.fail(w, r, "list municipalities", err)
		return
	}
	from := time.Date(fromYear, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(toYear, 12, 31, 0, 0, 0, 0, time.UTC)
	municipalMedians, err := s.statistics.MunicipalityMedians(ctx,
		analytics.StatisticsFilter{FromDate: &from, ToDate: &to, PropertyGroup: propertyGroup})
	if err != nil {
		s.fail(w, r, "calculate municipal medians", err)
		return
	}
	medians := map[int64]analytics.GeographyMedian{}
	for _, median := range municipalMedians {
		medians[median.GeographyID] = median
	}
	rates := affordability.Rates{Fixed: fixed.Value, Variable: variable.Value}
	items := make([]map[string]any, 0, len(units))
	for _, unit := range units {
		key, fallback := "SI", true
		if unit.Code != nil && len(wages[fmt.Sprintf("municipality:%d", *unit.Code)]) > 0 {
			key, fallback = fmt.Sprintf("municipality:%d", *unit.Code), false
		}
		var bands []affordability.Band
		period := ""
		for _, observation := range wages[key] {
			period = observation.Period
			if observation.Series == "net_wage_p50" {
				bands = append(bands, affordability.Band{ID: "p50", Income: observation.Value})
			}
			if observation.Series == "net_wage_mean" {
				bands = append(bands, affordability.Band{ID: "mean", Income: observation.Value})
			}
		}
		summary, known := medians[unit.ID]
		var median *float64
		sample := int64(0)
		if known {
			median, sample = summary.MedianPricePerSQM, summary.RepresentativeCount
		}
		items = append(items, map[string]any{
			"geographyId": unit.ID, "name": unit.Name, "wagePeriod": period, "nationalWageFallback": fallback,
			"medianPricePerSqm": median, "sampleSize": sample,
			"rows": affordability.Compute(bands, rule, rates, median),
		})
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"propertyGroup": propertyGroup, "fromYear": fromYear, "toYear": toYear, "rule": rule,
		"rates": map[string]any{"fixedOver10Years": fixed, "variable": variable},
		"items": items, "count": len(items),
		"disclaimer": "Statistična ponazoritev, ne ponudba kredita ali osebna ocena kreditne sposobnosti.",
	})
}
