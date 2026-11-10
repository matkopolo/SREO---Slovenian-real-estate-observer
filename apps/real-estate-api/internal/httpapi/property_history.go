package httpapi

import "net/http"

func (s *server) propertyHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := transactionID(w, r)
	if !ok {
		return
	}
	result, err := s.histories.PropertyHistory(r.Context(), id)
	if err != nil {
		s.fail(w, r, "load property history", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func (s *server) resaleSummary(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	result, err := s.histories.ResaleSummary(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "summarise resales", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
