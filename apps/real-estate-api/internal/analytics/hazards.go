package analytics

import (
	"context"
	"encoding/json"
	"fmt"
)

// FloodZone is one polygon of the DRSV flood hazard map (or of the studied area), simplified
// for the map, in WGS84.
type FloodZone struct {
	ID int64 `json:"id"`
	// Kind is "zone" for a hazard class polygon and "study" for an area with a hydraulic study.
	Kind        string          `json:"kind"`
	HazardClass *string         `json:"hazardClass"`
	Geometry    json.RawMessage `json:"geometry"`
}

// MaxFloodZones caps one answer. The drawn polygons are the hazard map's fragments dissolved per
// class and 2 km tile at import, so a municipality-sized view holds a few hundred of them.
const MaxFloodZones = 2000

// HazardStore answers the flood hazard overlay of the map.
type HazardStore interface {
	FloodZones(ctx context.Context, bbox [4]float64, tolerance float64) ([]FloodZone, bool, error)
}

// HazardRepository answers the DRSV flood hazard overlay (HazardStore).
type HazardRepository struct{ *queries }

// FloodZones lists the hazard polygons and studied areas intersecting bbox (west, south, east,
// north, WGS84), simplified by tolerance (degrees), largest first; the flag says whether the
// list was cut at MaxFloodZones.
func (r *HazardRepository) FloodZones(ctx context.Context, bbox [4]float64, tolerance float64) ([]FloodZone, bool, error) {
	rows, err := r.db.Query(ctx, `
		WITH view AS (SELECT ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3794) AS box)
		SELECT id, kind, hazard_class, ST_AsGeoJSON(
		         CASE WHEN $5::float8 > 0 THEN ST_SimplifyPreserveTopology(ST_Transform(geom, 4326), $5)
		              ELSE ST_Transform(geom, 4326) END, 6)::jsonb
		FROM (
		  SELECT z.id, 'zone' AS kind, z.hazard_class, ST_CollectionExtract(ST_Intersection(z.geom, view.box), 3) AS geom,
		         ST_Area(z.geom) AS size
		  FROM analytics.flood_hazard_areas z, view WHERE z.geom && view.box
		  UNION ALL
		  SELECT a.id, 'study', NULL, ST_CollectionExtract(ST_Intersection(a.geom, view.box), 3), ST_Area(a.geom)
		  FROM analytics.flood_study_areas a, view WHERE a.geom && view.box
		) clipped
		WHERE NOT ST_IsEmpty(geom)
		ORDER BY kind DESC, size DESC
		LIMIT $6`, bbox[0], bbox[1], bbox[2], bbox[3], tolerance, MaxFloodZones+1)
	if err != nil {
		return nil, false, fmt.Errorf("list flood zones: %w", err)
	}
	defer rows.Close()
	zones := make([]FloodZone, 0)
	for rows.Next() {
		var zone FloodZone
		if err := rows.Scan(&zone.ID, &zone.Kind, &zone.HazardClass, &zone.Geometry); err != nil {
			return nil, false, fmt.Errorf("scan flood zone: %w", err)
		}
		zones = append(zones, zone)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(zones) > MaxFloodZones {
		return zones[:MaxFloodZones], true, nil
	}
	return zones, false, nil
}
