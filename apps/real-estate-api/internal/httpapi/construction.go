package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
)

const (
	constructionMinYear     = 1900
	constructionPointZoom   = 12.0
	constructionMaxFeatures = 3000
)

func (s *server) constructionFilter(w http.ResponseWriter, r *http.Request) (construction.Filter, bool) {
	query := r.URL.Query()
	thisYear := s.now().Year()
	filter := construction.Filter{FromYear: thisYear - 5, ToYear: thisYear, MaxMapFeatures: constructionMaxFeatures}
	for name, target := range map[string]*int{"fromYear": &filter.FromYear, "toYear": &filter.ToYear} {
		if raw := query.Get(name); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < constructionMinYear || value > thisYear {
				writeError(w, r, http.StatusBadRequest, "invalid_"+strings.ToLower(name), name+" must be a year between 1900 and the current year")
				return filter, false
			}
			*target = value
		}
	}
	if filter.FromYear > filter.ToYear {
		writeError(w, r, http.StatusBadRequest, "invalid_year_range", "fromYear must not exceed toYear")
		return filter, false
	}
	var ok bool
	if filter.GeographyID, ok = optionalGeographyID(w, r); !ok {
		return filter, false
	}
	filter.WithDwellings = query.Get("withDwellings") == "true"
	return filter, true
}

func (s *server) constructionSummary(w http.ResponseWriter, r *http.Request) {
	filter, ok := s.constructionFilter(w, r)
	if !ok {
		return
	}
	summary, err := s.construction.Summary(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "summarise construction sources", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"filter":  map[string]any{"fromYear": filter.FromYear, "toYear": filter.ToYear, "withDwellings": filter.WithDwellings},
		"summary": summary,
		"sources": []map[string]string{
			{"name": "GURS, Kataster nepremičnin — stavbe", "licence": "CC BY 4.0", "note": "Vpisane stavbe; leto izgradnje po katastru. Ne prikazuje gradenj v teku."},
			{"name": "SURS 1970717S — dovoljenja za gradnjo stavb", "licence": "Vir: SURS", "note": "Število izdanih dovoljenj po občinah in letih; ni posameznih projektov."},
		},
	})
}

func (s *server) constructionMap(w http.ResponseWriter, r *http.Request) {
	filter, ok := s.constructionFilter(w, r)
	if !ok {
		return
	}
	bounds, ok := mapBounds(w, r)
	if !ok {
		return
	}
	filter.BoundingBox = &[4]float64{bounds.West, bounds.South, bounds.East, bounds.North}
	zoom, err := strconv.ParseFloat(r.URL.Query().Get("zoom"), 64)
	if err != nil || zoom < 0 || zoom > 22 {
		writeError(w, r, http.StatusBadRequest, "invalid_zoom", "zoom must be between 0 and 22")
		return
	}
	buildings := zoom >= constructionPointZoom
	features, truncated, err := s.construction.MapFeatures(r.Context(), filter, buildings)
	if err != nil {
		s.fail(w, r, "load construction map features", err)
		return
	}
	level := "municipality"
	if buildings {
		level = "building"
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"level": level, "items": features, "count": len(features), "truncated": truncated})
}

func (s *server) constructionBuilding(w http.ResponseWriter, r *http.Request) {
	eid := r.PathValue("eid")
	if eid == "" || len(eid) > 40 || strings.Trim(eid, "0123456789") != "" {
		writeError(w, r, http.StatusBadRequest, "invalid_building_id", "building id must be a GURS EID_STAVBA number")
		return
	}
	building, err := s.construction.Building(r.Context(), eid)
	if err != nil {
		s.fail(w, r, "load building", err)
		return
	}
	writeJSON(w, r, http.StatusOK, building)
}
