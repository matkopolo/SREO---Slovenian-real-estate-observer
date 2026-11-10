package analytics

import (
	"context"
	"fmt"
)

type Bounds struct {
	West, South, East, North float64
}

type Cluster struct {
	Longitude           float64  `json:"longitude"`
	Latitude            float64  `json:"latitude"`
	TransactionCount    int64    `json:"transactionCount"`
	RepresentativeCount int64    `json:"representativeCount"`
	MedianPricePerSQM   *float64 `json:"medianPricePerSqm"`
	MedianAmount        *float64 `json:"medianAmount,omitempty"`
}

type PropertyPoint struct {
	TransactionID             int64    `json:"transactionId"`
	CadastralMunicipalityCode *int32   `json:"cadastralMunicipalityCode"`
	BuildingNumber            *string  `json:"buildingNumber"`
	Longitude                 float64  `json:"longitude"`
	Latitude                  float64  `json:"latitude"`
	ContractDate              *string  `json:"contractDate"`
	PropertyGroup             string   `json:"propertyGroup"`
	Area                      *float64 `json:"area"`
	Price                     *float64 `json:"price"`
	PricePerSQM               *float64 `json:"pricePerSqm"`
	IsRepresentative          bool     `json:"isRepresentative"`
}

type GeographySummary struct {
	GeographyID         int64     `json:"geographyId"`
	Level               string    `json:"level"`
	Name                string    `json:"name"`
	Longitude           float64   `json:"longitude"`
	Latitude            float64   `json:"latitude"`
	Bounds              []float64 `json:"bounds"`
	TransactionCount    int64     `json:"transactionCount"`
	RepresentativeCount int64     `json:"representativeCount"`
	MedianAmountPerSQM  *float64  `json:"medianAmountPerSqm"`
	MedianAmount        *float64  `json:"medianAmount"`
}

// maxGeographySummaries caps one map-summary response. The busiest units come first, and the
// expensive label placement runs only for the units returned.
const maxGeographySummaries = 1200

type MapStore interface {
	Clusters(context.Context, StatisticsFilter, Bounds, float64) ([]Cluster, error)
	PropertyPoints(context.Context, StatisticsFilter, Bounds, int) ([]PropertyPoint, error)
	GeographySummaries(context.Context, StatisticsFilter, Bounds, string, string) ([]GeographySummary, error)
	BuildingSummaries(context.Context, StatisticsFilter, Bounds, string, int) ([]BuildingSummary, error)
}

// BuildingSummary aggregates the recorded agreements of one building (cadastral code + number).
type BuildingSummary struct {
	CadastralMunicipalityCode int32    `json:"cadastralMunicipalityCode"`
	BuildingNumber            string   `json:"buildingNumber"`
	Longitude                 float64  `json:"longitude"`
	Latitude                  float64  `json:"latitude"`
	TransactionCount          int64    `json:"transactionCount"`
	RepresentativeCount       int64    `json:"representativeCount"`
	MedianAmountPerSQM        *float64 `json:"medianAmountPerSqm"`
	LatestContractDate        *string  `json:"latestContractDate"`
	Settlement                *string  `json:"settlement"`
	Street                    *string  `json:"street"`
	HouseNumber               *string  `json:"houseNumber"`
	HouseNumberSuffix         *string  `json:"houseNumberSuffix"`
	ConstructionYear          *int32   `json:"constructionYear"`
}

// Local administrative polygons can include large unbuilt extensions. Use
// distinct recorded building locations across both markets and all years to
// anchor their labels. UNION removes repeated sales/rentals at the same metre
// grid location. Current analytical filters and viewport never affect this anchor.
const geographyBuildingAnchorJoin = `LEFT JOIN LATERAL (
	SELECT ST_Centroid(ST_Collect(location)) AS point
	FROM (
		SELECT ST_SnapToGrid(part.location,1) AS location
		FROM building_parts part
		WHERE unit.level IN ('city_district','local_community','settlement')
		  AND part.location && unit.geometry_d96tm
		  AND ST_Covers(unit.geometry_d96tm,part.location)
		UNION
		SELECT ST_SnapToGrid(part.location,1) AS location
		FROM rental_building_parts part
		WHERE unit.level IN ('city_district','local_community','settlement')
		  AND part.location && unit.geometry_d96tm
		  AND ST_Covers(unit.geometry_d96tm,part.location)
	) locations
) building_anchor ON true`

// Project the preferred anchor into a 20-metre interior buffer. Tiny/narrow
// polygons with an empty buffer retain a guaranteed point on their surface.
const geographyLabelPointExpression = `ST_Transform(
	CASE
		WHEN ST_IsEmpty(ST_Buffer(unit.geometry_d96tm,-20))
			THEN ST_PointOnSurface(unit.geometry_d96tm)
		ELSE ST_ClosestPoint(
			ST_Buffer(unit.geometry_d96tm,-20),
			coalesce(unit.label_anchor,ST_Centroid(unit.geometry_d96tm))
		)
	END,
	4326
)`

func (r *MapRepository) GeographySummaries(
	ctx context.Context,
	filter StatisticsFilter,
	bounds Bounds,
	level string,
	kind string,
) ([]GeographySummary, error) {
	table, metric, amountMetric := saleFactsTable(filter), "price_per_sqm", "price"
	if kind == "rent" {
		table, metric, amountMetric = "analytics.rental_facts", "monthly_rent_per_sqm", "monthly_rent_ex_vat"
	}
	join := "TRUE"
	if level != "country" {
		column, ok := geographyFactColumns[level]
		if !ok {
			return nil, fmt.Errorf("unsupported map geography level %q", level)
		}
		join = "fact." + column + "=unit.id"
	}
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	query := fmt.Sprintf(`
		WITH summaries AS MATERIALIZED (
		SELECT unit.id,unit.level,unit.name,unit.geometry_d96tm,
		  ARRAY[ST_XMin(extent),ST_YMin(extent),ST_XMax(extent),ST_YMax(extent)]::float8[] AS bounds,
		  count(*)::bigint AS transaction_count,
		  count(*) FILTER (WHERE fact.representative_eligible)::bigint AS representative_count,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY fact.%s)
		    FILTER (WHERE fact.representative_eligible)::float8 AS median_per_sqm,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY fact.%s)
		    FILTER (WHERE fact.representative_eligible)::float8 AS median_amount
		FROM analytics.geographic_units unit
		JOIN %s fact ON %s
		CROSS JOIN LATERAL ST_Envelope(unit.geometry_wgs84) extent
		WHERE unit.level=%s
		  AND unit.geometry_wgs84 && ST_MakeEnvelope(%s,%s,%s,%s,4326)
		  AND %s
		GROUP BY unit.id,unit.level,unit.name,unit.geometry_wgs84,extent
		ORDER BY transaction_count DESC,unit.id
		LIMIT %d
		), anchors AS MATERIALIZED (
		  SELECT unit.*, building_anchor.point AS label_anchor
		  FROM summaries unit %s
		), labels AS MATERIALIZED (
		  SELECT unit.*, %s AS label FROM anchors unit
		)
		SELECT id,level,name,ST_X(label),ST_Y(label),bounds,
		  transaction_count,representative_count,median_per_sqm,median_amount
		FROM labels ORDER BY transaction_count DESC,id`,
		metric, amountMetric, table, join, args.add(level),
		args.add(bounds.West), args.add(bounds.South), args.add(bounds.East), args.add(bounds.North),
		where, maxGeographySummaries, geographyBuildingAnchorJoin, geographyLabelPointExpression)
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%s geography summaries: %w", kind, err)
	}
	defer rows.Close()
	items := make([]GeographySummary, 0)
	for rows.Next() {
		var item GeographySummary
		if err := rows.Scan(
			&item.GeographyID, &item.Level, &item.Name,
			&item.Longitude, &item.Latitude, &item.Bounds,
			&item.TransactionCount, &item.RepresentativeCount,
			&item.MedianAmountPerSQM, &item.MedianAmount,
		); err != nil {
			return nil, fmt.Errorf("scan geography summary: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *MapRepository) Clusters(
	ctx context.Context,
	filter StatisticsFilter,
	bounds Bounds,
	gridSize float64,
) ([]Cluster, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	grid := args.add(gridSize)
	query := fmt.Sprintf(`
		WITH bounded AS (
			SELECT
				ST_SnapToGrid(ST_Transform(fact.location,4326),%[3]s,%[3]s) AS grid_point,
				fact.price_per_sqm,fact.representative_eligible
			FROM %[1]s fact
			WHERE fact.location IS NOT NULL
			  AND fact.location && %[4]s
			  AND %[2]s
		)
		SELECT ST_X(grid_point),ST_Y(grid_point),count(*)::bigint,
		       count(*) FILTER (WHERE representative_eligible)::bigint,
		       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm)
		           FILTER (WHERE representative_eligible)::float8
		FROM bounded
		GROUP BY grid_point
		ORDER BY count(*) DESC
		LIMIT 5000`, saleFactsTable(filter), where, grid, boundsEnvelope(bounds, &args))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("map clusters: %w", err)
	}
	defer rows.Close()
	items := make([]Cluster, 0)
	for rows.Next() {
		var item Cluster
		if err := rows.Scan(
			&item.Longitude, &item.Latitude, &item.TransactionCount,
			&item.RepresentativeCount, &item.MedianPricePerSQM,
		); err != nil {
			return nil, fmt.Errorf("scan map cluster: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate map clusters: %w", err)
	}
	return items, nil
}

func (r *MapRepository) PropertyPoints(
	ctx context.Context,
	filter StatisticsFilter,
	bounds Bounds,
	limit int,
) ([]PropertyPoint, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	query := fmt.Sprintf(`
		SELECT fact.transaction_id,fact.cadastral_municipality_code,fact.building_number,
		       ST_X(ST_Transform(fact.location,4326)),
		       ST_Y(ST_Transform(fact.location,4326)),fact.contract_date::text,
		       fact.property_group,fact.area::float8,fact.price::float8,fact.price_per_sqm::float8,
		       fact.representative_eligible
		FROM %s fact
		WHERE fact.location IS NOT NULL
		  AND fact.location && %s
		  AND %s
		ORDER BY fact.contract_date DESC NULLS LAST,fact.transaction_id
		LIMIT %s`, saleFactsTable(filter), boundsEnvelope(bounds, &args), where, args.add(limit))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("map property points: %w", err)
	}
	defer rows.Close()
	items := make([]PropertyPoint, 0)
	for rows.Next() {
		var item PropertyPoint
		if err := rows.Scan(
			&item.TransactionID, &item.CadastralMunicipalityCode,
			&item.BuildingNumber, &item.Longitude, &item.Latitude, &item.ContractDate,
			&item.PropertyGroup, &item.Area, &item.Price, &item.PricePerSQM,
			&item.IsRepresentative,
		); err != nil {
			return nil, fmt.Errorf("scan map property point: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate map property points: %w", err)
	}
	return items, nil
}

// BuildingSummaries groups sale (kind "sale") or rental (kind "rent") agreements by building inside
// the bounds; the median uses representative agreements only. Busiest buildings come first.
func (r *MapRepository) BuildingSummaries(
	ctx context.Context, filter StatisticsFilter, bounds Bounds, kind string, limit int,
) ([]BuildingSummary, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	table, amount := saleFactsTable(filter), "price_per_sqm"
	if kind == "rent" {
		table, amount = "analytics.rental_facts", "monthly_rent_per_sqm"
	}
	query := fmt.Sprintf(`
		WITH grouped AS (
		SELECT fact.cadastral_municipality_code, fact.building_number,
		       avg(ST_X(ST_Transform(fact.location,4326))) lon, avg(ST_Y(ST_Transform(fact.location,4326))) lat,
		       count(*)::bigint n, count(*) FILTER (WHERE fact.representative_eligible)::bigint representative,
		       percentile_cont(.5) WITHIN GROUP (ORDER BY fact.%[2]s) FILTER (WHERE fact.representative_eligible)::float8 median,
		       max(fact.contract_date)::text latest, min(fact.construction_year)::int construction_year
		FROM %[1]s fact
		WHERE fact.location IS NOT NULL AND fact.cadastral_municipality_code IS NOT NULL AND fact.building_number IS NOT NULL
		  AND fact.location && %[4]s
		  AND %[3]s
		GROUP BY fact.cadastral_municipality_code, fact.building_number
		ORDER BY count(*) DESC, fact.cadastral_municipality_code, fact.building_number
		LIMIT %[5]s)
		SELECT g.cadastral_municipality_code, g.building_number, g.lon, g.lat, g.n, g.representative, g.median, g.latest,
		       a.settlement, a.street, a.house_number, a.house_number_suffix, g.construction_year
		FROM grouped g
		LEFT JOIN LATERAL (
		  SELECT settlement, street, house_number::text house_number, house_number_suffix FROM building_parts b
		  WHERE b.cadastral_municipality_code = g.cadastral_municipality_code AND b.building_number = g.building_number
		    AND b.street IS NOT NULL
		  LIMIT 1) a ON true
		ORDER BY g.n DESC, g.cadastral_municipality_code, g.building_number`,
		table, amount, where, boundsEnvelope(bounds, &args), args.add(limit))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("map building summaries: %w", err)
	}
	defer rows.Close()
	items := make([]BuildingSummary, 0)
	for rows.Next() {
		var item BuildingSummary
		if err := rows.Scan(&item.CadastralMunicipalityCode, &item.BuildingNumber, &item.Longitude, &item.Latitude,
			&item.TransactionCount, &item.RepresentativeCount, &item.MedianAmountPerSQM, &item.LatestContractDate,
			&item.Settlement, &item.Street, &item.HouseNumber, &item.HouseNumberSuffix, &item.ConstructionYear); err != nil {
			return nil, fmt.Errorf("scan map building summary: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// boundsEnvelope returns the WGS84 bounds as a D96/TM envelope expression for fact.location.
func boundsEnvelope(bounds Bounds, args *queryArgs) string {
	return fmt.Sprintf("ST_Transform(ST_MakeEnvelope(%s,%s,%s,%s,4326),3794)",
		args.add(bounds.West), args.add(bounds.South), args.add(bounds.East), args.add(bounds.North))
}
