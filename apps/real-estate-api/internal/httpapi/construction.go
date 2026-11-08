package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
)

const (
	constructionMinYear     = 1900
	constructionPointZoom   = 12.0
	constructionMaxFeatures = 3000
)

func (s *server) constructionFilter(w http.ResponseWriter, r *http.Request) (construction.Filter, bool) {
	query := r.URL.Query()
	thisYear := time.Now().Year()
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
	if raw := query.Get("geographyId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, r, http.StatusBadRequest, "invalid_geography_id", "geographyId must be a positive integer")
			return filter, false
		}
		filter.GeographyID = &id
	}
	filter.WithDwellings = query.Get("withDwellings") == "true"
	return filter, true
}

func (s *server) constructionReady(w http.ResponseWriter, r *http.Request) bool {
	if s.construction == nil {
		writeError(w, r, http.StatusServiceUnavailable, "construction_unavailable", "construction sources are not configured")
		return false
	}
	return true
}

func (s *server) constructionSummary(w http.ResponseWriter, r *http.Request) {
	if !s.constructionReady(w, r) {
		return
	}
	filter, ok := s.constructionFilter(w, r)
	if !ok {
		return
	}
	summary, err := s.construction.Summary(r.Context(), filter)
	if errors.Is(err, construction.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "geography_not_found", "geography was not found")
		return
	}
	if err != nil {
		s.logger.Error("construction summary", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not summarise construction sources")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"filter":  map[string]any{"fromYear": filter.FromYear, "toYear": filter.ToYear, "withDwellings": filter.WithDwellings},
		"summary": summary,
		"sources": []map[string]string{
			{"name": "GURS, Kataster nepremičnin — stavbe", "licence": "CC BY 4.0", "note": "Vpisane stavbe; leto izgradnje po katastru. Ne prikazuje gradenj v teku."},
			{"name": "SURS 1970717S — dovoljenja za gradnjo stavb", "licence": "Vir: SURS", "note": "Število izdanih dovoljenj po občinah in letih; ni posameznih projektov."},
			{"name": "EU TED — javna naročila gradbenih del (CPV 45)", "licence": "Odločba Komisije 2011/833/EU", "note": "Le javna naročila nad pragom EU; lokacija na ravni regije."},
		},
	})
}

func (s *server) constructionMap(w http.ResponseWriter, r *http.Request) {
	if !s.constructionReady(w, r) {
		return
	}
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
		s.logger.Error("construction map", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not load construction map features")
		return
	}
	level := "municipality"
	if buildings {
		level = "building"
	}
	writeJSON(w, http.StatusOK, map[string]any{"level": level, "items": features, "count": len(features), "truncated": truncated})
}

func (s *server) constructionBuilding(w http.ResponseWriter, r *http.Request) {
	if !s.constructionReady(w, r) {
		return
	}
	eid := r.PathValue("eid")
	if eid == "" || len(eid) > 40 || strings.Trim(eid, "0123456789") != "" {
		writeError(w, r, http.StatusBadRequest, "invalid_building_id", "building id must be a GURS EID_STAVBA number")
		return
	}
	building, err := s.construction.Building(r.Context(), eid)
	if errors.Is(err, construction.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "building_not_found", "building was not found")
		return
	}
	if err != nil {
		s.logger.Error("construction building", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not load building")
		return
	}
	writeJSON(w, http.StatusOK, building)
}

func (s *server) constructionPublicWorks(w http.ResponseWriter, r *http.Request) {
	if !s.constructionReady(w, r) {
		return
	}
	filter, ok := s.constructionFilter(w, r)
	if !ok {
		return
	}
	limit, ok := boundedInteger(w, r, "limit", 20, 1, 100)
	if !ok {
		return
	}
	offset, ok := boundedInteger(w, r, "offset", 0, 0, 100000)
	if !ok {
		return
	}
	notices, total, err := s.construction.PublicWorks(r.Context(), filter.GeographyID, limit, offset)
	if err != nil {
		s.logger.Error("construction public works", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not load public works")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": notices, "total": total, "limit": limit, "offset": offset})
}
