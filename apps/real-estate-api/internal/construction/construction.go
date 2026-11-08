// Package construction serves the official construction sources behind "Gradbeni projekti":
// GURS registered buildings, SURS building-permit counts and EU TED public-works notices.
// Registered buildings are completed (or measurable) buildings, never construction in progress.
package construction

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("construction record not found")

// Filter narrows registered buildings. GeographyID nil means Slovenia.
type Filter struct {
	GeographyID    *int64
	FromYear       int
	ToYear         int
	WithDwellings  bool
	BoundingBox    *[4]float64 // west, south, east, north (WGS84)
	MaxMapFeatures int
}

type YearCount struct {
	Year           int     `json:"year"`
	Buildings      int64   `json:"buildings"`
	Dwellings      int64   `json:"dwellings"`
	GrossFloorArea float64 `json:"grossFloorArea"`
}

type PermitYear struct {
	Year      string   `json:"year"`
	Buildings *float64 `json:"buildings"`
	Dwellings *float64 `json:"dwellings"`
	FloorArea *float64 `json:"floorArea"`
}

type Summary struct {
	SourceDate        *string      `json:"sourceDate"`
	BuildingsByYear   []YearCount  `json:"buildingsByYear"`
	Permits           []PermitYear `json:"permits"`
	PermitsScope      string       `json:"permitsScope"`
	PublicWorks12m    int64        `json:"publicWorksLast12Months"`
	PublicWorksAwards int64        `json:"publicWorksAwardsLast12Months"`
	PublicWorksScope  string       `json:"publicWorksScope"`
}

type MapFeature struct {
	Kind        string  `json:"kind"` // "area" or "building"
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Longitude   float64 `json:"longitude"`
	Latitude    float64 `json:"latitude"`
	Buildings   int64   `json:"buildings"`
	Dwellings   int64   `json:"dwellings"`
	YearBuilt   *int    `json:"yearBuilt,omitempty"`
	GeographyID *int64  `json:"geographyId,omitempty"`
}

type Building struct {
	EID                  string   `json:"eid"`
	CadastralCode        int      `json:"cadastralCode"`
	BuildingNumber       int      `json:"buildingNumber"`
	YearBuilt            *int     `json:"yearBuilt"`
	Floors               *int     `json:"floors"`
	Dwellings            *int     `json:"dwellings"`
	BusinessUnits        *int     `json:"businessUnits"`
	BuildingType         *string  `json:"buildingType"`
	LoadBearingStructure *string  `json:"loadBearingStructure"`
	RegistrationStatus   *string  `json:"registrationStatus"`
	GrossFloorArea       *float64 `json:"grossFloorArea"`
	RecordChangedOn      *string  `json:"recordChangedOn"`
	Municipality         *string  `json:"municipality"`
	MunicipalityID       *int64   `json:"municipalityId"`
	Longitude            *float64 `json:"longitude"`
	Latitude             *float64 `json:"latitude"`
	SaleTransactions     int64    `json:"saleTransactions"`
	RentalTransactions   int64    `json:"rentalTransactions"`
	SourceDate           string   `json:"sourceDate"`
}

type Notice struct {
	PublicationNumber string   `json:"publicationNumber"`
	NoticeType        string   `json:"noticeType"`
	PublicationDate   string   `json:"publicationDate"`
	Title             string   `json:"title"`
	Buyer             *string  `json:"buyer"`
	Winners           []string `json:"winners"`
	Regions           []string `json:"regions"`
	Value             *float64 `json:"value"`
	Currency          *string  `json:"currency"`
	URL               string   `json:"url"`
}

type Store interface {
	Summary(context.Context, Filter) (Summary, error)
	MapFeatures(context.Context, Filter, bool) ([]MapFeature, bool, error)
	Building(context.Context, string) (Building, error)
	PublicWorks(context.Context, *int64, int, int) ([]Notice, int64, error)
}

type Repository struct{ pool *pgxpool.Pool }

func NewRepository(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// area is a CTE selecting the boundary of the requested geography (Slovenia when NULL).
const area = `area AS (
	SELECT geometry_d96tm AS geometry, level, id FROM analytics.geographic_units
	WHERE id = coalesce($1::bigint, (SELECT id FROM analytics.geographic_units WHERE level = 'country' LIMIT 1))
)`

// municipalities selects the SURS geography keys of the municipalities in the requested area.
// The hierarchy is country → statistical region → municipality → district/community/settlement.
const municipalities = `municipalities AS (
	SELECT DISTINCT 'municipality:' || m.code::text AS key
	FROM analytics.geographic_units g
	JOIN analytics.geographic_units m ON m.level = 'municipality' AND m.code IS NOT NULL
	 AND (m.id = g.id                 -- the area is a municipality
	      OR m.id = g.parent_id       -- the area lies inside a municipality
	      OR m.parent_id = g.id       -- the area is a statistical region
	      OR g.level = 'country')
	WHERE g.id = coalesce($1::bigint, (SELECT id FROM analytics.geographic_units WHERE level = 'country' LIMIT 1))
)`

func (r *Repository) Summary(ctx context.Context, filter Filter) (Summary, error) {
	var summary Summary
	if err := r.pool.QueryRow(ctx, `SELECT max(source_date)::text FROM analytics.cadastre_buildings`).Scan(&summary.SourceDate); err != nil {
		return Summary{}, fmt.Errorf("building snapshot: %w", err)
	}
	rows, err := r.pool.Query(ctx, `WITH `+area+`
		SELECT b.year_built, count(*), coalesce(sum(b.dwellings), 0), coalesce(sum(b.gross_floor_area), 0)::float8
		FROM analytics.cadastre_buildings b, area
		WHERE b.year_built BETWEEN $2 AND $3 AND ST_Covers(area.geometry, b.location)
		  AND (NOT $4 OR b.dwellings > 0)
		GROUP BY 1 ORDER BY 1`, filter.GeographyID, filter.FromYear, filter.ToYear, filter.WithDwellings)
	if err != nil {
		return Summary{}, fmt.Errorf("buildings by year: %w", err)
	}
	if summary.BuildingsByYear, err = pgx.CollectRows(rows, pgx.RowToStructByPos[YearCount]); err != nil {
		return Summary{}, fmt.Errorf("buildings by year: %w", err)
	}

	var level string
	if err := r.pool.QueryRow(ctx, `WITH `+area+` SELECT level FROM area`, filter.GeographyID).Scan(&level); errors.Is(err, pgx.ErrNoRows) {
		return Summary{}, ErrNotFound
	} else if err != nil {
		return Summary{}, fmt.Errorf("geography level: %w", err)
	}
	permitKeys := `SELECT key FROM municipalities`
	summary.PermitsScope = "municipalities"
	if level == "country" {
		permitKeys, summary.PermitsScope = `SELECT 'SI'`, "slovenia"
	}
	rows, err = r.pool.Query(ctx, `WITH `+municipalities+`
		SELECT period,
		       sum(value) FILTER (WHERE series = 'permit_buildings')::float8,
		       sum(value) FILTER (WHERE series = 'permit_dwellings')::float8,
		       sum(value) FILTER (WHERE series = 'permit_floor_area')::float8
		FROM analytics.context_series
		WHERE source = 'surs' AND series LIKE 'permit\_%' AND geography_key IN (`+permitKeys+`)
		GROUP BY period ORDER BY period`, filter.GeographyID)
	if err != nil {
		return Summary{}, fmt.Errorf("permits: %w", err)
	}
	if summary.Permits, err = pgx.CollectRows(rows, pgx.RowToStructByPos[PermitYear]); err != nil {
		return Summary{}, fmt.Errorf("permits: %w", err)
	}

	summary.PublicWorksScope = "slovenia"
	err = r.pool.QueryRow(ctx, `WITH `+area+`, region AS (
			SELECT n.nuts3 FROM area
			JOIN analytics.geographic_units g ON g.id = area.id
			LEFT JOIN analytics.geographic_units p1 ON p1.id = g.parent_id
			LEFT JOIN analytics.geographic_units p2 ON p2.id = p1.parent_id
			JOIN analytics.nuts3_regions n ON n.region_name IN (
				CASE WHEN g.level = 'statistical_region' THEN g.name END,
				CASE WHEN p1.level = 'statistical_region' THEN p1.name END,
				CASE WHEN p2.level = 'statistical_region' THEN p2.name END)
		)
		SELECT count(*), count(*) FILTER (WHERE notice_type LIKE 'can%'),
		       CASE WHEN EXISTS (SELECT 1 FROM region) THEN 'region' ELSE 'slovenia' END
		FROM analytics.public_works_notices
		WHERE publication_date >= current_date - interval '12 months'
		  AND (NOT EXISTS (SELECT 1 FROM region) OR nuts3 && ARRAY(SELECT nuts3 FROM region))`,
		filter.GeographyID).Scan(&summary.PublicWorks12m, &summary.PublicWorksAwards, &summary.PublicWorksScope)
	if err != nil {
		return Summary{}, fmt.Errorf("public works: %w", err)
	}
	return summary, nil
}

// MapFeatures returns municipality aggregates, or building points when buildings is true.
func (r *Repository) MapFeatures(ctx context.Context, filter Filter, buildings bool) ([]MapFeature, bool, error) {
	box := filter.BoundingBox
	if buildings {
		rows, err := r.pool.Query(ctx, `
			SELECT 'building', b.eid, coalesce(t.label, 'stavba') || ' · ' || b.cadastral_code || '/' || b.building_number,
			       ST_X(ST_Transform(b.location, 4326)), ST_Y(ST_Transform(b.location, 4326)),
			       1::bigint, coalesce(b.dwellings, 0)::bigint, b.year_built, NULL::bigint
			FROM analytics.cadastre_buildings b
			LEFT JOIN analytics.cadastre_codebooks t ON t.codebook = 'building_type' AND t.code = b.building_type
			WHERE b.year_built BETWEEN $1 AND $2 AND (NOT $3 OR b.dwellings > 0)
			  AND b.location && ST_Transform(ST_MakeEnvelope($4, $5, $6, $7, 4326), 3794)
			ORDER BY b.year_built DESC, b.eid LIMIT $8`,
			filter.FromYear, filter.ToYear, filter.WithDwellings, box[0], box[1], box[2], box[3], filter.MaxMapFeatures+1)
		if err != nil {
			return nil, false, fmt.Errorf("building points: %w", err)
		}
		features, err := pgx.CollectRows(rows, scanFeature)
		if err != nil {
			return nil, false, fmt.Errorf("building points: %w", err)
		}
		truncated := len(features) > filter.MaxMapFeatures
		if truncated {
			features = features[:filter.MaxMapFeatures]
		}
		return features, truncated, nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT 'area', m.id::text, m.name,
		       ST_X(ST_Transform(ST_PointOnSurface(m.geometry_d96tm), 4326)),
		       ST_Y(ST_Transform(ST_PointOnSurface(m.geometry_d96tm), 4326)),
		       count(b.eid), coalesce(sum(b.dwellings), 0)::bigint, NULL::int, m.id
		FROM analytics.geographic_units m
		JOIN analytics.cadastre_buildings b ON b.municipality_eid = m.gurs_eid
		WHERE m.level = 'municipality' AND b.year_built BETWEEN $1 AND $2 AND (NOT $3 OR b.dwellings > 0)
		  AND m.geometry_wgs84 && ST_MakeEnvelope($4, $5, $6, $7, 4326)
		GROUP BY m.id, m.name, m.geometry_d96tm
		ORDER BY count(b.eid) DESC LIMIT 300`,
		filter.FromYear, filter.ToYear, filter.WithDwellings, box[0], box[1], box[2], box[3])
	if err != nil {
		return nil, false, fmt.Errorf("municipality aggregates: %w", err)
	}
	features, err := pgx.CollectRows(rows, scanFeature)
	return features, false, err
}

func scanFeature(row pgx.CollectableRow) (MapFeature, error) {
	var feature MapFeature
	err := row.Scan(&feature.Kind, &feature.ID, &feature.Name, &feature.Longitude, &feature.Latitude,
		&feature.Buildings, &feature.Dwellings, &feature.YearBuilt, &feature.GeographyID)
	return feature, err
}

func (r *Repository) Building(ctx context.Context, eid string) (Building, error) {
	var building Building
	err := r.pool.QueryRow(ctx, `
		SELECT b.eid, b.cadastral_code, b.building_number, b.year_built, b.floors, b.dwellings, b.business_units,
		       t.label, s.label, st.label, b.gross_floor_area::float8, b.record_changed_on::text,
		       m.name, m.id, ST_X(ST_Transform(b.location, 4326)), ST_Y(ST_Transform(b.location, 4326)),
		       (SELECT count(DISTINCT transaction_id) FROM building_parts p
		         WHERE p.cadastral_municipality_code = b.cadastral_code AND p.building_number = b.building_number::text),
		       (SELECT count(DISTINCT transaction_id) FROM rental_building_parts p
		         WHERE p.cadastral_municipality_code = b.cadastral_code AND p.building_number = b.building_number::text),
		       b.source_date::text
		FROM analytics.cadastre_buildings b
		LEFT JOIN analytics.cadastre_codebooks t ON t.codebook = 'building_type' AND t.code = b.building_type
		LEFT JOIN analytics.cadastre_codebooks s ON s.codebook = 'load_bearing_structure' AND s.code = b.load_bearing_structure
		LEFT JOIN analytics.cadastre_codebooks st ON st.codebook = 'registration_status' AND st.code = b.registration_status
		LEFT JOIN analytics.geographic_units m ON m.level = 'municipality' AND m.gurs_eid = b.municipality_eid
		WHERE b.eid = $1`, eid).Scan(
		&building.EID, &building.CadastralCode, &building.BuildingNumber, &building.YearBuilt, &building.Floors,
		&building.Dwellings, &building.BusinessUnits, &building.BuildingType, &building.LoadBearingStructure,
		&building.RegistrationStatus, &building.GrossFloorArea, &building.RecordChangedOn, &building.Municipality,
		&building.MunicipalityID, &building.Longitude, &building.Latitude, &building.SaleTransactions,
		&building.RentalTransactions, &building.SourceDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return Building{}, ErrNotFound
	}
	if err != nil {
		return Building{}, fmt.Errorf("building %s: %w", eid, err)
	}
	return building, nil
}

func (r *Repository) PublicWorks(ctx context.Context, geographyID *int64, limit, offset int) ([]Notice, int64, error) {
	const regionFilter = `WITH ` + area + `, region AS (
			SELECT n.nuts3 FROM area
			JOIN analytics.geographic_units g ON g.id = area.id
			LEFT JOIN analytics.geographic_units p1 ON p1.id = g.parent_id
			LEFT JOIN analytics.geographic_units p2 ON p2.id = p1.parent_id
			JOIN analytics.nuts3_regions n ON n.region_name IN (
				CASE WHEN g.level = 'statistical_region' THEN g.name END,
				CASE WHEN p1.level = 'statistical_region' THEN p1.name END,
				CASE WHEN p2.level = 'statistical_region' THEN p2.name END)
		), notices AS (
			SELECT * FROM analytics.public_works_notices
			WHERE NOT EXISTS (SELECT 1 FROM region) OR nuts3 && ARRAY(SELECT nuts3 FROM region)
		)`
	var total int64
	if err := r.pool.QueryRow(ctx, regionFilter+` SELECT count(*) FROM notices`, geographyID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("public works count: %w", err)
	}
	rows, err := r.pool.Query(ctx, regionFilter+`
		SELECT n.publication_number, n.notice_type, n.publication_date::text, n.title, n.buyer, n.winners,
		       coalesce(ARRAY(SELECT r.region_name FROM analytics.nuts3_regions r WHERE r.nuts3 = ANY(n.nuts3) ORDER BY 1), '{}'),
		       n.value::float8, n.currency, n.url
		FROM notices n ORDER BY n.publication_date DESC, n.publication_number DESC LIMIT $2 OFFSET $3`,
		geographyID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("public works: %w", err)
	}
	notices, err := pgx.CollectRows(rows, pgx.RowToStructByPos[Notice])
	return notices, total, err
}
