package analytics

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
)

var ErrGeographyNotFound = errors.New("geography not found")

const descriptivePublicationThreshold int64 = 30

type StatisticsFilter struct {
	FromDate      *time.Time
	ToDate        *time.Time
	PropertyGroup string
	GeographyID   *int64
	LandScope     string
	MinArea       *float64
	MaxArea       *float64
}

type Overview struct {
	TransactionCount      int64    `json:"transactionCount"`
	EligibleCount         int64    `json:"eligibleCount"`
	IncludedSampleSize    int64    `json:"includedSampleSize"`
	ExcludedOutlierCount  int64    `json:"excludedOutlierCount"`
	PriceSampleSize       int64    `json:"priceSampleSize"`
	PricePerSQMSampleSize int64    `json:"pricePerSqmSampleSize"`
	MedianPrice           *float64 `json:"medianPrice"`
	CleanedAveragePrice   *float64 `json:"cleanedAveragePrice"`
	RawAveragePrice       *float64 `json:"rawAveragePrice"`
	MedianPricePerSQM     *float64 `json:"medianPricePerSqm"`
	CleanedAveragePerSQM  *float64 `json:"cleanedAveragePricePerSqm"`
	RawAveragePerSQM      *float64 `json:"rawAveragePricePerSqm"`
	MedianArea            *float64 `json:"medianArea"`
	IsPublishable         bool     `json:"isPublishable"`
	SuppressionReason     *string  `json:"suppressionReason"`
}

type TimeSeriesPoint struct {
	Period                string   `json:"period"`
	Incomplete            bool     `json:"incomplete"`
	TransactionCount      int64    `json:"transactionCount"`
	EligibleCount         int64    `json:"eligibleCount"`
	IncludedSampleSize    int64    `json:"includedSampleSize"`
	ExcludedOutlierCount  int64    `json:"excludedOutlierCount"`
	PriceSampleSize       int64    `json:"priceSampleSize"`
	PricePerSQMSampleSize int64    `json:"pricePerSqmSampleSize"`
	MedianPrice           *float64 `json:"medianPrice"`
	CleanedAveragePrice   *float64 `json:"cleanedAveragePrice"`
	RawAveragePrice       *float64 `json:"rawAveragePrice"`
	MedianPricePerSQM     *float64 `json:"medianPricePerSqm"`
	CleanedAveragePerSQM  *float64 `json:"cleanedAveragePricePerSqm"`
	RawAveragePerSQM      *float64 `json:"rawAveragePricePerSqm"`
	MedianArea            *float64 `json:"medianArea"`
	IsPublishable         bool     `json:"isPublishable"`
	SuppressionReason     *string  `json:"suppressionReason"`
}

type StatisticsStore interface {
	Overview(context.Context, StatisticsFilter) (Overview, error)
	TimeSeries(context.Context, StatisticsFilter, string) ([]TimeSeriesPoint, error)
	Outliers(context.Context, StatisticsFilter, int, int) ([]OutlierRecord, int64, error)
	TransactionExtremes(context.Context, string, StatisticsFilter, int) ([]TransactionExtreme, error)
	MunicipalityMedians(context.Context, StatisticsFilter) ([]GeographyMedian, error)
}

// GeographyMedian is the representative sale median of one geography.
type GeographyMedian struct {
	GeographyID         int64
	RepresentativeCount int64
	MedianPricePerSQM   *float64
}

type OutlierRecord struct {
	TransactionID             int64    `json:"transactionId"`
	ContractDate              *string  `json:"contractDate"`
	PropertyGroup             string   `json:"propertyGroup"`
	Area                      *float64 `json:"area"`
	Price                     *float64 `json:"price"`
	PricePerSQM               *float64 `json:"pricePerSqm"`
	CadastralMunicipalityCode *int32   `json:"cadastralMunicipalityCode,omitempty"`
	BuildingNumber            *string  `json:"buildingNumber,omitempty"`
	BuildingPartNumber        *string  `json:"buildingPartNumber,omitempty"`
	CohortLevel               string   `json:"cohortLevel"`
	CohortSize                int      `json:"cohortSize"`
	CohortMedian              float64  `json:"cohortMedian"`
	LowerBound                float64  `json:"lowerBound"`
	UpperBound                float64  `json:"upperBound"`
	ModifiedZScore            *float64 `json:"modifiedZScore"`
	RuleVersion               string   `json:"ruleVersion"`
}

// StatisticsRepository answers every analytics query from the published fact tables.
type StatisticsRepository struct {
	db     database.Querier
	now    func() time.Time
	levels geographyLevels
	// search is the in-memory address index of SearchBuildings, reloaded per release.
	search *memo.Value[*releaseIndex]
}

// NewStatisticsRepository returns a repository reading through db (a pool, or a test transaction).
func NewStatisticsRepository(db database.Querier) *StatisticsRepository {
	r := &StatisticsRepository{db: db, now: time.Now, levels: geographyLevels{byID: map[int64]string{}}}
	r.search = newAddressIndexCache(r)
	return r
}

func (r *StatisticsRepository) Overview(ctx context.Context, filter StatisticsFilter) (Overview, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return Overview{}, err
	}
	query := fmt.Sprintf(`
		SELECT
			count(*)::bigint,
			count(*) FILTER (WHERE is_quality_eligible)::bigint,
			count(*) FILTER (WHERE representative_eligible)::bigint,
			count(*) FILTER (WHERE is_quality_eligible AND NOT representative_eligible)::bigint,
			count(price) FILTER (WHERE representative_eligible)::bigint,
			count(price_per_sqm) FILTER (WHERE representative_eligible)::bigint,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
				FILTER (WHERE representative_eligible)::float8,
			avg(price) FILTER (WHERE representative_eligible)::float8,
			avg(price) FILTER (WHERE is_quality_eligible)::float8,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm)
				FILTER (WHERE representative_eligible)::float8,
			avg(price_per_sqm) FILTER (WHERE representative_eligible)::float8,
			avg(price_per_sqm) FILTER (WHERE is_quality_eligible)::float8,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY area)
				FILTER (WHERE representative_eligible)::float8
		FROM %s fact
		WHERE %s`, saleFactsTable(filter), where)
	var result Overview
	err = r.db.QueryRow(ctx, query, args...).Scan(
		&result.TransactionCount, &result.EligibleCount,
		&result.IncludedSampleSize, &result.ExcludedOutlierCount,
		&result.PriceSampleSize, &result.PricePerSQMSampleSize,
		&result.MedianPrice, &result.CleanedAveragePrice, &result.RawAveragePrice,
		&result.MedianPricePerSQM, &result.CleanedAveragePerSQM, &result.RawAveragePerSQM,
		&result.MedianArea,
	)
	if err != nil {
		return Overview{}, fmt.Errorf("overview statistics: %w", err)
	}
	applyPublicationPolicy(result.IncludedSampleSize,
		&result.IsPublishable, &result.SuppressionReason)
	return result, nil
}

func (r *StatisticsRepository) TimeSeries(
	ctx context.Context,
	filter StatisticsFilter,
	interval string,
) ([]TimeSeriesPoint, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	truncUnit, step := intervalSQL(interval)
	query := fmt.Sprintf(`
		SELECT
			date_trunc('%s',contract_date)::date,
			(date_trunc('%s',contract_date)+interval '%s'>(SELECT coalesce(max(r.analytics_sale_through), current_date::timestamptz) - interval '3 months' FROM analytics.analytical_releases r JOIN analytics.analytical_publication p ON r.id = p.active_release_id)),
			count(*)::bigint,
			count(*) FILTER (WHERE is_quality_eligible)::bigint,
			count(*) FILTER (WHERE representative_eligible)::bigint,
			count(*) FILTER (WHERE is_quality_eligible AND NOT representative_eligible)::bigint,
			count(price) FILTER (WHERE representative_eligible)::bigint,
			count(price_per_sqm) FILTER (WHERE representative_eligible)::bigint,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
				FILTER (WHERE representative_eligible)::float8,
			avg(price) FILTER (WHERE representative_eligible)::float8,
			avg(price) FILTER (WHERE is_quality_eligible)::float8,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm)
				FILTER (WHERE representative_eligible)::float8,
			avg(price_per_sqm) FILTER (WHERE representative_eligible)::float8,
			avg(price_per_sqm) FILTER (WHERE is_quality_eligible)::float8,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY area)
				FILTER (WHERE representative_eligible)::float8
		FROM %s fact
		WHERE fact.contract_date IS NOT NULL AND %s
		GROUP BY 1,2 ORDER BY 1`, truncUnit, truncUnit, step,
		saleFactsTable(filter), where)
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("time-series statistics: %w", err)
	}
	defer rows.Close()
	points := make([]TimeSeriesPoint, 0)
	for rows.Next() {
		var period time.Time
		var point TimeSeriesPoint
		if err := rows.Scan(
			&period, &point.Incomplete, &point.TransactionCount,
			&point.EligibleCount, &point.IncludedSampleSize, &point.ExcludedOutlierCount,
			&point.PriceSampleSize, &point.PricePerSQMSampleSize,
			&point.MedianPrice, &point.CleanedAveragePrice, &point.RawAveragePrice,
			&point.MedianPricePerSQM, &point.CleanedAveragePerSQM, &point.RawAveragePerSQM,
			&point.MedianArea,
		); err != nil {
			return nil, fmt.Errorf("scan time-series statistics: %w", err)
		}
		point.Period = period.Format("2006-01-02")
		applyPublicationPolicy(point.IncludedSampleSize,
			&point.IsPublishable, &point.SuppressionReason)
		points = append(points, point)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate time-series statistics: %w", err)
	}
	return points, nil
}

func applyPublicationPolicy(sampleSize int64, publishable *bool, reason **string) {
	*publishable = sampleSize >= descriptivePublicationThreshold
	if *publishable {
		*reason = nil
		return
	}
	value := "below_minimum_sample_30"
	*reason = &value
}

func (r *StatisticsRepository) Outliers(
	ctx context.Context,
	filter StatisticsFilter,
	limit, offset int,
) ([]OutlierRecord, int64, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, 0, err
	}
	query := fmt.Sprintf(`
		SELECT
			count(*) OVER ()::bigint,
			fact.transaction_id,
			fact.contract_date::text,
			fact.property_group,
			fact.area::float8,
			fact.price::float8,
			fact.price_per_sqm::float8,
			fact.cadastral_municipality_code,
			fact.building_number,
			fact.building_part_number,
			evaluation.cohort_level,
			evaluation.cohort_size,
			evaluation.cohort_median::float8,
			evaluation.lower_bound::float8,
			evaluation.upper_bound::float8,
			evaluation.modified_z_score::float8,
			evaluation.rule_version
		FROM %s fact
		JOIN analytics.sale_outlier_evaluations evaluation USING (transaction_id)
		WHERE evaluation.status='outlier' AND %s
		ORDER BY evaluation.modified_z_score DESC NULLS LAST,fact.transaction_id
		LIMIT %s OFFSET %s`, saleFactsTable(filter), where, args.add(limit), args.add(offset))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list statistical outliers: %w", err)
	}
	defer rows.Close()
	items := make([]OutlierRecord, 0)
	var total int64
	for rows.Next() {
		var item OutlierRecord
		if err := rows.Scan(
			&total, &item.TransactionID, &item.ContractDate, &item.PropertyGroup,
			&item.Area, &item.Price, &item.PricePerSQM,
			&item.CadastralMunicipalityCode, &item.BuildingNumber, &item.BuildingPartNumber,
			&item.CohortLevel, &item.CohortSize, &item.CohortMedian,
			&item.LowerBound, &item.UpperBound, &item.ModifiedZScore, &item.RuleVersion,
		); err != nil {
			return nil, 0, fmt.Errorf("scan statistical outlier: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate statistical outliers: %w", err)
	}
	return items, total, nil
}

// MunicipalityMedians returns the representative median EUR/m2 of every municipality with
// agreements matching the filter: one grouped scan of the facts, without geometry work.
func (r *StatisticsRepository) MunicipalityMedians(ctx context.Context, filter StatisticsFilter) ([]GeographyMedian, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, fmt.Sprintf(`
		SELECT fact.municipality_id,
		  count(*) FILTER (WHERE fact.representative_eligible)::bigint,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY fact.price_per_sqm)
		    FILTER (WHERE fact.representative_eligible)::float8
		FROM %s fact
		WHERE fact.municipality_id IS NOT NULL AND %s
		GROUP BY fact.municipality_id`, saleFactsTable(filter), where), args...)
	if err != nil {
		return nil, fmt.Errorf("municipality medians: %w", err)
	}
	defer rows.Close()
	items := []GeographyMedian{}
	for rows.Next() {
		var item GeographyMedian
		if err := rows.Scan(&item.GeographyID, &item.RepresentativeCount, &item.MedianPricePerSQM); err != nil {
			return nil, fmt.Errorf("scan municipality median: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
