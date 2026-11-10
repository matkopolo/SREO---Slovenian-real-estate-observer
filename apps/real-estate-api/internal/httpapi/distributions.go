package httpapi

import "net/http"

func (s *server) saleDistribution(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	metric := r.URL.Query().Get("metric")
	if metric == "" {
		metric = "pricePerSqm"
	}
	if metric != "price" && metric != "pricePerSqm" {
		writeError(w, r, http.StatusBadRequest, "invalid_metric",
			"metric must be price or pricePerSqm")
		return
	}
	bins, ok := boundedInteger(w, r, "bins", 20, 5, 100)
	if !ok {
		return
	}
	result, err := s.distributions.SaleDistribution(r.Context(), filter, metric, bins)
	if err != nil {
		s.fail(w, r, "calculate distribution", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func (s *server) rentalDistribution(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	metric := r.URL.Query().Get("metric")
	if metric == "" {
		metric = "rentPerSqm"
	}
	if metric != "monthlyRent" && metric != "rentPerSqm" {
		writeError(w, r, http.StatusBadRequest, "invalid_metric",
			"metric must be monthlyRent or rentPerSqm")
		return
	}
	bins, ok := boundedInteger(w, r, "bins", 20, 5, 100)
	if !ok {
		return
	}
	result, err := s.distributions.RentalDistribution(r.Context(), filter, metric, bins)
	if err != nil {
		s.fail(w, r, "calculate distribution", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
