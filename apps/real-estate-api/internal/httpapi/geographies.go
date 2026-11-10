package httpapi

import (
	"net/http"
	"strconv"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
)

func (s *server) listGeographies(w http.ResponseWriter, r *http.Request) {
	level := r.URL.Query().Get("level")
	if level != "" && !validGeographyLevel(level) {
		writeError(w, r, http.StatusBadRequest, "invalid_level", "unsupported geography level")
		return
	}
	var parentID *int64
	if value := r.URL.Query().Get("parentId"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 1 {
			writeError(w, r, http.StatusBadRequest, "invalid_parent_id", "parentId must be a positive integer")
			return
		}
		parentID = &parsed
	}
	units, err := s.geographies.List(r.Context(), geography.Filter{Level: level, ParentID: parentID})
	if err != nil {
		s.fail(w, r, "load geographies", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": units, "count": len(units)})
}

func (s *server) geographyChildren(w http.ResponseWriter, r *http.Request) {
	id, ok := geographyID(w, r)
	if !ok {
		return
	}
	units, err := s.geographies.Children(r.Context(), id)
	if err != nil {
		s.fail(w, r, "load geography children", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": units, "count": len(units)})
}

func (s *server) getGeography(w http.ResponseWriter, r *http.Request) {
	id, ok := geographyID(w, r)
	if !ok {
		return
	}
	unit, err := s.geographies.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, "load geography", err)
		return
	}
	writeJSON(w, r, http.StatusOK, unit)
}

func (s *server) geographyBoundary(w http.ResponseWriter, r *http.Request) {
	id, ok := geographyID(w, r)
	if !ok {
		return
	}
	tolerance, valid := boundaryTolerance(r.URL.Query().Get("detail"))
	if !valid {
		writeError(w, r, http.StatusBadRequest, "invalid_detail", "detail must be low, medium, or full")
		return
	}
	boundary, err := s.geographies.Boundary(r.Context(), id, tolerance)
	if err != nil {
		s.fail(w, r, "load geography boundary", err)
		return
	}
	writeGeoJSON(w, r, http.StatusOK, map[string]any{
		"type":       "Feature",
		"id":         boundary.Unit.ID,
		"properties": boundary.Unit,
		"geometry":   boundary.Geometry,
	})
}

// geographyBoundaries returns the outlines of all statistical regions or municipalities, or of
// the finer units inside a bounding box (the map's visible area), at most geography.MaxBoundaries.
// Unsimplified outlines (detail=full) are served only one geography at a time.
func (s *server) geographyBoundaries(w http.ResponseWriter, r *http.Request) {
	level := r.URL.Query().Get("level")
	fine := level == "city_district" || level == "local_community" || level == "settlement"
	if level != "statistical_region" && level != "municipality" && !fine {
		writeError(w, r, http.StatusBadRequest, "invalid_level", "level must be statistical_region, municipality, city_district, local_community or settlement")
		return
	}
	var bbox *[4]float64
	if raw := r.URL.Query().Get("bbox"); raw != "" || fine {
		bounds, ok := mapBounds(w, r)
		if !ok {
			return
		}
		bbox = &[4]float64{bounds.West, bounds.South, bounds.East, bounds.North}
	}
	detail := r.URL.Query().Get("detail")
	if detail == "full" {
		writeError(w, r, http.StatusBadRequest, "invalid_detail",
			"detail=full is available only for one geography (/geographies/{id}/boundary); use low or medium")
		return
	}
	tolerance, valid := boundaryTolerance(detail)
	if !valid {
		writeError(w, r, http.StatusBadRequest, "invalid_detail", "detail must be low or medium")
		return
	}
	boundaries, err := s.geographies.Boundaries(r.Context(), level, tolerance, bbox)
	if err != nil {
		s.fail(w, r, "load geography boundaries", err)
		return
	}
	features := make([]map[string]any, 0, len(boundaries))
	for _, boundary := range boundaries {
		features = append(features, map[string]any{
			"type": "Feature", "id": boundary.Unit.ID, "properties": boundary.Unit, "geometry": boundary.Geometry,
		})
	}
	writeGeoJSON(w, r, http.StatusOK, map[string]any{"type": "FeatureCollection", "features": features, "count": len(features)})
}

func geographyID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		writeError(w, r, http.StatusBadRequest, "invalid_geography_id", "geography id must be a positive integer")
		return 0, false
	}
	return id, true
}

// optionalGeographyID reads the optional geographyId query parameter.
func optionalGeographyID(w http.ResponseWriter, r *http.Request) (*int64, bool) {
	value := r.URL.Query().Get("geographyId")
	if value == "" {
		return nil, true
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 {
		writeError(w, r, http.StatusBadRequest, "invalid_geography_id", "geographyId must be a positive integer")
		return nil, false
	}
	return &parsed, true
}

func boundaryTolerance(detail string) (float64, bool) {
	switch detail {
	case "", "medium":
		return 0.0001, true
	case "low":
		return 0.001, true
	case "full":
		return 0, true
	default:
		return 0, false
	}
}

func validGeographyLevel(level string) bool {
	switch level {
	case "country", "statistical_region", "municipality", "city_district", "local_community", "settlement":
		return true
	default:
		return false
	}
}
