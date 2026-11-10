package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
)

// maxPageOffset bounds offset on every paged list: deeper pages are slow and never needed.
const maxPageOffset = 100000

func (s *server) statisticsOverview(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	result, err := s.statistics.Overview(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "calculate overview statistics", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func (s *server) statisticsTimeSeries(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	interval, ok := intervalParameter(w, r)
	if !ok {
		return
	}
	items, err := s.statistics.TimeSeries(r.Context(), filter, interval)
	if err != nil {
		s.fail(w, r, "calculate time-series statistics", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"interval": interval, "items": items, "count": len(items)})
}

func (s *server) statisticsOutliers(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	limit, offset, ok := pageParameters(w, r, 50, 100)
	if !ok {
		return
	}
	items, total, err := s.statistics.Outliers(r.Context(), filter, limit, offset)
	if err != nil {
		s.fail(w, r, "load statistical outliers", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"items": items, "count": len(items), "total": total, "limit": limit, "offset": offset,
	})
}

func (s *server) transactionExtremes(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	kind, ok := transactionKindParameter(w, r)
	if !ok {
		return
	}
	limit, ok := boundedInteger(w, r, "limit", 3, 1, 10)
	if !ok {
		return
	}
	items, err := s.statistics.TransactionExtremes(r.Context(), kind, filter, limit)
	if err != nil {
		s.fail(w, r, "calculate transaction extremes", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items, "count": len(items), "population": "representative"})
}

func (s *server) recentTransactions(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	kind, ok := transactionKindParameter(w, r)
	if !ok {
		return
	}
	limit, offset, ok := pageParameters(w, r, 10, 100)
	if !ok {
		return
	}
	sort := r.URL.Query().Get("sort")
	if sort == "" {
		sort = "date"
	}
	if sort != "date" && sort != "price" && sort != "perSqm" && sort != "area" {
		writeError(w, r, http.StatusBadRequest, "invalid_sort", "sort must be date, price, perSqm or area")
		return
	}
	order := r.URL.Query().Get("order")
	if order != "" && order != "asc" && order != "desc" {
		writeError(w, r, http.StatusBadRequest, "invalid_order", "order must be asc or desc")
		return
	}
	street := strings.TrimSpace(r.URL.Query().Get("street"))
	if len(street) > 120 {
		writeError(w, r, http.StatusBadRequest, "invalid_street", "street is too long")
		return
	}
	page := analytics.RecentPage{Limit: limit, Offset: offset, Sort: sort, Descending: order != "asc", Street: street}
	items, total, err := s.recent.RecentTransactions(r.Context(), kind, filter, page)
	if err != nil {
		s.fail(w, r, "load recent transactions", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items, "count": len(items), "total": total, "offset": offset, "transactionKind": kind})
}

func statisticsFilter(w http.ResponseWriter, r *http.Request) (analytics.StatisticsFilter, bool) {
	var filter analytics.StatisticsFilter
	var ok bool
	if filter.FromDate, filter.ToDate, ok = dateRange(w, r); !ok {
		return filter, false
	}
	if filter.MinArea, ok = optionalPositiveFloat(w, r, "minArea"); !ok {
		return filter, false
	}
	if filter.MaxArea, ok = optionalPositiveFloat(w, r, "maxArea"); !ok {
		return filter, false
	}
	if filter.MinArea != nil && filter.MaxArea != nil && *filter.MinArea > *filter.MaxArea {
		writeError(w, r, http.StatusBadRequest, "invalid_area_range", "minArea must not exceed maxArea")
		return filter, false
	}
	filter.PropertyGroup = r.URL.Query().Get("propertyGroup")
	if filter.PropertyGroup != "" && !validPropertyGroup(filter.PropertyGroup) {
		writeError(w, r, http.StatusBadRequest, "invalid_property_group", "unsupported propertyGroup")
		return filter, false
	}
	filter.LandScope = r.URL.Query().Get("landScope")
	if filter.LandScope == "" {
		filter.LandScope = "strict"
	}
	switch filter.LandScope {
	case "strict", "broad", "all", "agricultural", "forest", "unverified", "mixed", "other":
	default:
		writeError(w, r, http.StatusBadRequest, "invalid_land_scope",
			"landScope must be strict, broad, all, agricultural, forest, unverified, mixed, or other")
		return filter, false
	}
	if filter.GeographyID, ok = optionalGeographyID(w, r); !ok {
		return filter, false
	}
	return filter, true
}

// dateRange reads the optional from/to dates and checks their order.
func dateRange(w http.ResponseWriter, r *http.Request) (*time.Time, *time.Time, bool) {
	from, ok := optionalDate(w, r, "from")
	if !ok {
		return nil, nil, false
	}
	to, ok := optionalDate(w, r, "to")
	if !ok {
		return nil, nil, false
	}
	if from != nil && to != nil && from.After(*to) {
		writeError(w, r, http.StatusBadRequest, "invalid_date_range", "from must not be after to")
		return nil, nil, false
	}
	return from, to, true
}

func intervalParameter(w http.ResponseWriter, r *http.Request) (string, bool) {
	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "year"
	}
	if interval != "month" && interval != "quarter" && interval != "year" {
		writeError(w, r, http.StatusBadRequest, "invalid_interval", "interval must be month, quarter, or year")
		return "", false
	}
	return interval, true
}

// transactionKindParameter reads transactionKind (sale or rent, default sale).
func transactionKindParameter(w http.ResponseWriter, r *http.Request) (string, bool) {
	kind := r.URL.Query().Get("transactionKind")
	if kind == "" {
		kind = "sale"
	}
	if kind != "sale" && kind != "rent" {
		writeError(w, r, http.StatusBadRequest, "invalid_transaction_kind", "transactionKind must be sale or rent")
		return "", false
	}
	return kind, true
}

// pageParameters reads limit (1..maxLimit) and offset (0..maxPageOffset).
func pageParameters(w http.ResponseWriter, r *http.Request, defaultLimit, maxLimit int) (int, int, bool) {
	limit, ok := boundedInteger(w, r, "limit", defaultLimit, 1, maxLimit)
	if !ok {
		return 0, 0, false
	}
	offset, ok := boundedInteger(w, r, "offset", 0, 0, maxPageOffset)
	if !ok {
		return 0, 0, false
	}
	return limit, offset, true
}

func optionalPositiveFloat(w http.ResponseWriter, r *http.Request, name string) (*float64, bool) {
	value := r.URL.Query().Get(name)
	if value == "" {
		return nil, true
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || parsed <= 0 || parsed > 1000000 {
		writeError(w, r, http.StatusBadRequest, "invalid_area", name+" must be a positive number")
		return nil, false
	}
	return &parsed, true
}

func optionalDate(w http.ResponseWriter, r *http.Request, name string) (*time.Time, bool) {
	value := r.URL.Query().Get(name)
	if value == "" {
		return nil, true
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_date", name+" must use YYYY-MM-DD")
		return nil, false
	}
	return &parsed, true
}

func validPropertyGroup(group string) bool {
	switch group {
	case "apartment", "house", "land", "commercial", "garage", "room", "mixed", "unknown":
		return true
	default:
		return false
	}
}

func boundedInteger(
	w http.ResponseWriter,
	r *http.Request,
	name string,
	fallback, minimum, maximum int,
) (int, bool) {
	value := r.URL.Query().Get(name)
	if value == "" {
		return fallback, true
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		writeError(w, r, http.StatusBadRequest, "invalid_"+name,
			name+" is outside the supported range")
		return 0, false
	}
	return parsed, true
}
