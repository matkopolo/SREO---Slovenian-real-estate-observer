package geography

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
)

var ErrNotFound = errors.New("geography not found")

type Unit struct {
	ID            int64     `db:"id" json:"id"`
	Level         string    `db:"level" json:"level"`
	Code          *int32    `db:"code" json:"code,omitempty"`
	CompositeCode *int32    `db:"composite_code" json:"compositeCode,omitempty"`
	Name          string    `db:"name" json:"name"`
	ParentID      *int64    `db:"parent_id" json:"parentId,omitempty"`
	GURSEID       string    `db:"gurs_eid" json:"gursEid"`
	Bounds        []float64 `db:"bounds" json:"bounds,omitempty"`
}

type Filter struct {
	Level    string
	ParentID *int64
}

type Store interface {
	List(context.Context, Filter) ([]Unit, error)
	Get(context.Context, int64) (Unit, error)
	Children(context.Context, int64) ([]Unit, error)
	Boundary(context.Context, int64, float64) (Boundary, error)
	Boundaries(context.Context, string, float64, *[4]float64) ([]Boundary, error)
	Lineage(context.Context, int64) ([]Unit, error)
}

// MaxBoundaries caps one Boundaries response.
const MaxBoundaries = 1200

type Repository struct {
	pool  database.Querier
	table string
}

func NewRepository(pool database.Querier) *Repository {
	return NewRepositoryWithSchema(pool, "analytics")
}

func NewRepositoryWithSchema(pool database.Querier, schema string) *Repository {
	return &Repository{
		pool:  pool,
		table: pgx.Identifier{schema, "geographic_units"}.Sanitize(),
	}
}

type Boundary struct {
	Unit     Unit            `json:"properties"`
	Geometry json.RawMessage `json:"geometry"`
}

func (r *Repository) List(ctx context.Context, filter Filter) ([]Unit, error) {
	rows, err := r.pool.Query(ctx, fmt.Sprintf(`
		SELECT id, level, code, composite_code, name, parent_id, gurs_eid,
		       ARRAY[ST_XMin(extent), ST_YMin(extent), ST_XMax(extent), ST_YMax(extent)]::float8[] AS bounds
		FROM (
			SELECT id, level, code, composite_code, name, parent_id, gurs_eid,
			       ST_Envelope(geometry_wgs84) AS extent
			FROM %s
			WHERE ($1 = '' OR level = $1)
			  AND ($2::bigint IS NULL OR parent_id = $2)
		) units
		ORDER BY level, name, id`, r.table), filter.Level, filter.ParentID)
	if err != nil {
		return nil, fmt.Errorf("list geographies: %w", err)
	}
	defer rows.Close()

	units, err := pgx.CollectRows(rows, pgx.RowToStructByName[Unit])
	if err != nil {
		return nil, fmt.Errorf("collect geographies: %w", err)
	}
	return units, nil
}

func (r *Repository) Get(ctx context.Context, id int64) (Unit, error) {
	row, err := r.pool.Query(ctx, fmt.Sprintf(`
		SELECT id, level, code, composite_code, name, parent_id, gurs_eid,
		       ARRAY[ST_XMin(extent), ST_YMin(extent), ST_XMax(extent), ST_YMax(extent)]::float8[] AS bounds
		FROM (
			SELECT id, level, code, composite_code, name, parent_id, gurs_eid,
			       ST_Envelope(geometry_wgs84) AS extent
			FROM %s WHERE id=$1
		) unit`, r.table), id)
	if err != nil {
		return Unit{}, fmt.Errorf("get geography: %w", err)
	}
	unit, err := pgx.CollectOneRow(row, pgx.RowToStructByName[Unit])
	if errors.Is(err, pgx.ErrNoRows) {
		return Unit{}, ErrNotFound
	}
	if err != nil {
		return Unit{}, fmt.Errorf("collect geography: %w", err)
	}
	return unit, nil
}

func (r *Repository) Children(ctx context.Context, parentID int64) ([]Unit, error) {
	var exists bool
	if err := r.pool.QueryRow(ctx,
		fmt.Sprintf("SELECT EXISTS(SELECT 1 FROM %s WHERE id=$1)", r.table), parentID,
	).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check geography: %w", err)
	}
	if !exists {
		return nil, ErrNotFound
	}
	return r.List(ctx, Filter{ParentID: &parentID})
}

// Boundaries lists the units of a level with their (simplified) WGS84 geometry, at most
// MaxBoundaries; with bbox (west, south, east, north) only those intersecting it, nearest to
// its centre first.
func (r *Repository) Boundaries(ctx context.Context, level string, tolerance float64, bbox *[4]float64) ([]Boundary, error) {
	var west, south, east, north *float64
	if bbox != nil {
		west, south, east, north = &bbox[0], &bbox[1], &bbox[2], &bbox[3]
	}
	rows, err := r.pool.Query(ctx, fmt.Sprintf(`
		SELECT id, level, code, composite_code, name, parent_id, gurs_eid,
		       ARRAY[ST_XMin(geometry_wgs84), ST_YMin(geometry_wgs84), ST_XMax(geometry_wgs84), ST_YMax(geometry_wgs84)]::float8[],
		       ST_AsGeoJSON(CASE WHEN $2::float8 > 0 THEN ST_SimplifyPreserveTopology(geometry_wgs84, $2)
		                         ELSE geometry_wgs84 END, 6)::jsonb
		FROM %s WHERE level = $1
		  AND ($3::float8 IS NULL OR geometry_wgs84 && ST_MakeEnvelope($3, $4, $5, $6, 4326))
		-- Nearest to the view centre first, so a cap drops outlines at the edges, not every name after "P".
		ORDER BY CASE WHEN $3::float8 IS NULL THEN 0
		              ELSE ST_Distance(ST_PointOnSurface(geometry_wgs84), ST_SetSRID(ST_MakePoint(($3 + $5) / 2, ($4 + $6) / 2), 4326)) END,
		         name, id
		LIMIT %d`, r.table, MaxBoundaries), level, tolerance, west, south, east, north)
	if err != nil {
		return nil, fmt.Errorf("list geography boundaries: %w", err)
	}
	defer rows.Close()
	var boundaries []Boundary
	for rows.Next() {
		var boundary Boundary
		unit := &boundary.Unit
		if err := rows.Scan(&unit.ID, &unit.Level, &unit.Code, &unit.CompositeCode, &unit.Name, &unit.ParentID,
			&unit.GURSEID, &unit.Bounds, &boundary.Geometry); err != nil {
			return nil, fmt.Errorf("scan geography boundary: %w", err)
		}
		boundaries = append(boundaries, boundary)
	}
	return boundaries, rows.Err()
}

func (r *Repository) Boundary(ctx context.Context, id int64, tolerance float64) (Boundary, error) {
	unit, err := r.Get(ctx, id)
	if err != nil {
		return Boundary{}, err
	}
	var geometry json.RawMessage
	err = r.pool.QueryRow(ctx, fmt.Sprintf(`
		SELECT ST_AsGeoJSON(
			CASE WHEN $2::float8 > 0
			     THEN ST_SimplifyPreserveTopology(geometry_wgs84,$2)
			     ELSE geometry_wgs84 END,
			6
		)::jsonb
		FROM %s WHERE id=$1`, r.table), id, tolerance).Scan(&geometry)
	if err != nil {
		return Boundary{}, fmt.Errorf("get geography boundary: %w", err)
	}
	return Boundary{Unit: unit, Geometry: geometry}, nil
}

// Lineage returns the unit and its ancestors, the unit first, in one query.
func (r *Repository) Lineage(ctx context.Context, id int64) ([]Unit, error) {
	rows, err := r.pool.Query(ctx, fmt.Sprintf(`
		WITH RECURSIVE lineage AS (
			SELECT id, level, code, composite_code, name, parent_id, gurs_eid, 0 AS depth FROM %[1]s WHERE id = $1
			UNION ALL
			SELECT parent.id, parent.level, parent.code, parent.composite_code, parent.name, parent.parent_id,
			       parent.gurs_eid, lineage.depth + 1
			FROM %[1]s parent JOIN lineage ON parent.id = lineage.parent_id
			WHERE lineage.depth < 10
		)
		SELECT id, level, code, composite_code, name, parent_id, gurs_eid, NULL::float8[] AS bounds
		FROM lineage ORDER BY depth`, r.table), id)
	if err != nil {
		return nil, fmt.Errorf("geography lineage: %w", err)
	}
	units, err := pgx.CollectRows(rows, pgx.RowToStructByName[Unit])
	if err != nil {
		return nil, fmt.Errorf("collect geography lineage: %w", err)
	}
	if len(units) == 0 {
		return nil, ErrNotFound
	}
	return units, nil
}
