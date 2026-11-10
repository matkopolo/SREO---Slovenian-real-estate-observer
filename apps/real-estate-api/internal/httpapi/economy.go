package httpapi

import (
	"net/http"
	"time"
)

func (s *server) inflation(w http.ResponseWriter, r *http.Request) {
	from, err := time.Parse("2006-01-02", r.URL.Query().Get("from"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_from", "from must use YYYY-MM-DD")
		return
	}
	to, err := time.Parse("2006-01-02", r.URL.Query().Get("to"))
	if err != nil || to.Before(from) {
		writeError(w, r, http.StatusBadRequest, "invalid_to", "to must use YYYY-MM-DD and not precede from")
		return
	}
	interval := r.URL.Query().Get("interval")
	if interval != "month" && interval != "quarter" && interval != "year" {
		writeError(w, r, http.StatusBadRequest, "invalid_interval", "interval must be month, quarter, or year")
		return
	}
	items, err := s.economics.Inflation(r.Context(), from, to, interval)
	if err != nil {
		requestLog(r).Warn("load inflation", "error", err)
		writeError(w, r, http.StatusBadGateway, "source_unavailable", "SURS inflation data is unavailable")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"items": items, "count": len(items), "source": "SURS SiStat H281S",
	})
}

func (s *server) inflationFactor(w http.ResponseWriter, r *http.Request) {
	from, ok := optionalDate(w, r, "from")
	if !ok {
		return
	}
	to, ok := optionalDate(w, r, "to")
	if !ok {
		return
	}
	if from == nil || to == nil || from.After(*to) || from.Year() < 1991 || to.After(s.now().UTC()) {
		writeError(w, r, http.StatusBadRequest, "invalid_date_range", "from/to must be ordered dates from 1991 through today")
		return
	}
	result, err := s.economics.InflationFactor(r.Context(), *from, *to)
	if err != nil {
		requestLog(r).Warn("inflation factor", "error", err)
		writeError(w, r, http.StatusServiceUnavailable, "inflation_unavailable", "complete monthly inflation series unavailable")
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
