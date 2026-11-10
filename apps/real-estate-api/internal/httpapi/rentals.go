package httpapi

import "net/http"

func (s *server) rentalOverview(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	result, err := s.rentals.RentalOverview(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "calculate rental overview", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func (s *server) rentalTimeSeries(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	interval, ok := intervalParameter(w, r)
	if !ok {
		return
	}
	items, err := s.rentals.RentalTimeSeries(r.Context(), filter, interval)
	if err != nil {
		s.fail(w, r, "calculate rental time series", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"interval": interval, "items": items, "count": len(items),
	})
}

func (s *server) rentalOutliers(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	limit, offset, ok := pageParameters(w, r, 50, 100)
	if !ok {
		return
	}
	items, total, err := s.rentals.RentalOutliers(r.Context(), filter, limit, offset)
	if err != nil {
		s.fail(w, r, "load rental outliers", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"items": items, "count": len(items), "total": total,
		"limit": limit, "offset": offset,
	})
}

func (s *server) rentalMapClusters(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	bounds, ok := mapBounds(w, r)
	if !ok {
		return
	}
	zoom, ok := boundedInteger(w, r, "zoom", 8, 0, 22)
	if !ok {
		return
	}
	items, err := s.rentals.RentalClusters(
		r.Context(), filter, bounds, clusterGridSize(zoom))
	if err != nil {
		s.fail(w, r, "load rental map clusters", err)
		return
	}
	features := make([]map[string]any, 0, len(items))
	for _, item := range items {
		features = append(features, map[string]any{
			"type": "Feature",
			"geometry": map[string]any{
				"type": "Point", "coordinates": []float64{item.Longitude, item.Latitude},
			},
			"properties": map[string]any{
				"transactionCount":        item.TransactionCount,
				"representativeCount":     item.RepresentativeCount,
				"medianMonthlyRentPerSqm": item.MedianPricePerSQM,
				"medianMonthlyRent":       item.MedianAmount,
			},
		})
	}
	writeGeoJSON(w, r, http.StatusOK, map[string]any{
		"type": "FeatureCollection", "features": features,
		"count": len(features), "zoom": zoom,
	})
}

func (s *server) rentalMapProperties(w http.ResponseWriter, r *http.Request) {
	filter, ok := statisticsFilter(w, r)
	if !ok {
		return
	}
	bounds, ok := mapBounds(w, r)
	if !ok {
		return
	}
	limit, ok := boundedInteger(w, r, "limit", 250, 1, 500)
	if !ok {
		return
	}
	items, err := s.rentals.RentalPropertyPoints(r.Context(), filter, bounds, limit)
	if err != nil {
		s.fail(w, r, "load rental map properties", err)
		return
	}
	features := make([]map[string]any, 0, len(items))
	for _, item := range items {
		features = append(features, map[string]any{
			"type": "Feature", "id": item.TransactionID,
			"geometry": map[string]any{
				"type": "Point", "coordinates": []float64{item.Longitude, item.Latitude},
			},
			"properties": item,
		})
	}
	writeGeoJSON(w, r, http.StatusOK, map[string]any{
		"type": "FeatureCollection", "features": features,
		"count": len(features), "limit": limit,
	})
}
