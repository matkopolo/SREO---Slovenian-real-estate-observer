package httpapi

import (
	"net/http"
)

// Flood polygons are drawn only on close views: the largest bbox served is about a
// municipality (0.26° on either axis).
const maxFloodViewDegrees = 0.26

// floodZones serves the DRSV flood hazard classes and studied areas inside the map's view as
// GeoJSON, simplified by detail (low, medium, high) for the zoom they are drawn at.
func (s *server) floodZones(w http.ResponseWriter, r *http.Request) {
	bounds, ok := mapBounds(w, r)
	if !ok {
		return
	}
	if bounds.East-bounds.West > maxFloodViewDegrees || bounds.North-bounds.South > maxFloodViewDegrees {
		writeError(w, r, http.StatusBadRequest, "bbox_too_large",
			"flood zones are served for views up to about one municipality; zoom in")
		return
	}
	tolerances := map[string]float64{"low": 0.0004, "medium": 0.00012, "high": 0.00003, "": 0.00012}
	tolerance, valid := tolerances[r.URL.Query().Get("detail")]
	if !valid {
		writeError(w, r, http.StatusBadRequest, "invalid_detail", "detail must be low, medium or high")
		return
	}
	zones, truncated, err := s.hazards.FloodZones(r.Context(),
		[4]float64{bounds.West, bounds.South, bounds.East, bounds.North}, tolerance)
	if err != nil {
		s.fail(w, r, "load flood zones", err)
		return
	}
	features := make([]map[string]any, 0, len(zones))
	for _, zone := range zones {
		features = append(features, map[string]any{
			"type": "Feature", "id": zone.ID, "geometry": zone.Geometry,
			"properties": map[string]any{"kind": zone.Kind, "hazardClass": zone.HazardClass},
		})
	}
	writeGeoJSON(w, r, http.StatusOK, map[string]any{
		"type": "FeatureCollection", "features": features, "count": len(features), "truncated": truncated,
		"sources": []map[string]string{{
			"name":    "DRSV, Integralna karta razredov poplavne nevarnosti (IKRPN) in območja hidrološko-hidravličnih modelov",
			"licence": "CC BY 4.0",
			"note":    "Razredi veljajo le na preučenih območjih; zunaj njih podatek ne pomeni, da poplav ni.",
		}},
	})
}
