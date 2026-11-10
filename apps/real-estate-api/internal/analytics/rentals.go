package analytics

import (
	"context"
	"fmt"
	"time"
)

const rentalWeakSampleThreshold = 20

type RentalOverview struct {
	TransactionCount        int64    `json:"transactionCount"`
	EligibleCount           int64    `json:"eligibleCount"`
	IncludedSampleSize      int64    `json:"includedSampleSize"`
	ExcludedOutlierCount    int64    `json:"excludedOutlierCount"`
	MonthlyRentSampleSize   int64    `json:"monthlyRentSampleSize"`
	RentPerSQMSampleSize    int64    `json:"rentPerSqmSampleSize"`
	MedianMonthlyRent       *float64 `json:"medianMonthlyRent"`
	CleanedAverageRent      *float64 `json:"cleanedAverageMonthlyRent"`
	RawAverageRent          *float64 `json:"rawAverageMonthlyRent"`
	MedianMonthlyRentPerSQM *float64 `json:"medianMonthlyRentPerSqm"`
	CleanedAveragePerSQM    *float64 `json:"cleanedAverageMonthlyRentPerSqm"`
	RawAveragePerSQM        *float64 `json:"rawAverageMonthlyRentPerSqm"`
	MedianArea              *float64 `json:"medianArea"`
	IsPublishable           bool     `json:"isPublishable"`
	SuppressionReason       *string  `json:"suppressionReason"`
}

type RentalTimeSeriesPoint struct {
	Period                   string   `json:"period"`
	Incomplete               bool     `json:"incomplete"`
	TransactionCount         int64    `json:"transactionCount"`
	IncludedSampleSize       int64    `json:"includedSampleSize"`
	MedianMonthlyRent        *float64 `json:"medianMonthlyRent"`
	MedianMonthlyRentPerSQM  *float64 `json:"medianMonthlyRentPerSqm"`
	PreviousYearSampleSize   *int64   `json:"previousYearSampleSize"`
	PreviousYearMedianRent   *float64 `json:"previousYearMedianMonthlyRent"`
	PreviousYearMedianPerSQM *float64 `json:"previousYearMedianMonthlyRentPerSqm"`
	MonthlyRentYoYPercent    *float64 `json:"monthlyRentYoYPercent"`
	RentPerSQMYoYPercent     *float64 `json:"rentPerSqmYoYPercent"`
	WeakComparisonSample     bool     `json:"weakComparisonSample"`
	IsPublishable            bool     `json:"isPublishable"`
	SuppressionReason        *string  `json:"suppressionReason"`
}

type RentalOutlierRecord struct {
	TransactionID     int64    `json:"transactionId"`
	ContractDate      *string  `json:"contractDate"`
	PropertyGroup     string   `json:"propertyGroup"`
	Area              *float64 `json:"area"`
	MonthlyRent       *float64 `json:"monthlyRent"`
	MonthlyRentPerSQM *float64 `json:"monthlyRentPerSqm"`
	CohortLevel       string   `json:"cohortLevel"`
	CohortSize        int      `json:"cohortSize"`
	CohortMedian      float64  `json:"cohortMedian"`
	LowerBound        float64  `json:"lowerBound"`
	UpperBound        float64  `json:"upperBound"`
	ModifiedZScore    *float64 `json:"modifiedZScore"`
	RuleVersion       string   `json:"ruleVersion"`
}

type RentalPropertyPoint struct {
	TransactionID             int64    `json:"transactionId"`
	CadastralMunicipalityCode *int32   `json:"cadastralMunicipalityCode"`
	BuildingNumber            *string  `json:"buildingNumber"`
	Longitude                 float64  `json:"longitude"`
	Latitude                  float64  `json:"latitude"`
	ContractDate              *string  `json:"contractDate"`
	PropertyGroup             string   `json:"propertyGroup"`
	Area                      *float64 `json:"area"`
	MonthlyRent               *float64 `json:"monthlyRent"`
	MonthlyRentPerSQM         *float64 `json:"monthlyRentPerSqm"`
	IsRepresentative          bool     `json:"isRepresentative"`
}

type RentalStatisticsStore interface {
	RentalOverview(context.Context, StatisticsFilter) (RentalOverview, error)
	RentalTimeSeries(context.Context, StatisticsFilter, string) ([]RentalTimeSeriesPoint, error)
	RentalOutliers(context.Context, StatisticsFilter, int, int) ([]RentalOutlierRecord, int64, error)
	RentalClusters(context.Context, StatisticsFilter, Bounds, float64) ([]Cluster, error)
	RentalPropertyPoints(context.Context, StatisticsFilter, Bounds, int) ([]RentalPropertyPoint, error)
}

func (r *RentalStatisticsRepository) RentalClusters(
	ctx context.Context, filter StatisticsFilter, bounds Bounds, gridSize float64,
) ([]Cluster, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	query := fmt.Sprintf(`
		WITH bounded AS (
		  SELECT ST_SnapToGrid(ST_Transform(fact.location,4326),%[2]s,%[2]s) grid_point,
		    fact.monthly_rent_per_sqm,fact.monthly_rent_ex_vat,fact.representative_eligible
		  FROM analytics.rental_facts fact
		  WHERE fact.location IS NOT NULL
		    AND fact.location && %[3]s
		    AND %[1]s
		)
		SELECT ST_X(grid_point),ST_Y(grid_point),count(*)::bigint,
		  count(*) FILTER (WHERE representative_eligible)::bigint,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY monthly_rent_per_sqm)
		    FILTER (WHERE representative_eligible)::float8,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY monthly_rent_ex_vat)
		    FILTER (WHERE representative_eligible)::float8
		FROM bounded GROUP BY grid_point ORDER BY count(*) DESC LIMIT 5000`,
		where, args.add(gridSize), boundsEnvelope(bounds, &args))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("rental map clusters: %w", err)
	}
	defer rows.Close()
	items := make([]Cluster, 0)
	for rows.Next() {
		var item Cluster
		if err := rows.Scan(&item.Longitude, &item.Latitude,
			&item.TransactionCount, &item.RepresentativeCount,
			&item.MedianPricePerSQM, &item.MedianAmount); err != nil {
			return nil, fmt.Errorf("scan rental cluster: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *RentalStatisticsRepository) RentalPropertyPoints(
	ctx context.Context, filter StatisticsFilter, bounds Bounds, limit int,
) ([]RentalPropertyPoint, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	query := fmt.Sprintf(`
		SELECT fact.transaction_id,fact.cadastral_municipality_code,fact.building_number,
		  ST_X(ST_Transform(fact.location,4326)),
		  ST_Y(ST_Transform(fact.location,4326)),fact.contract_date::text,fact.property_group,
		  fact.area::float8,fact.monthly_rent_ex_vat::float8,
		  fact.monthly_rent_per_sqm::float8,fact.representative_eligible
		FROM analytics.rental_facts fact
		WHERE fact.location IS NOT NULL
		  AND fact.location && %s
		  AND %s
		ORDER BY fact.contract_date DESC NULLS LAST,fact.transaction_id LIMIT %s`,
		boundsEnvelope(bounds, &args), where, args.add(limit))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("rental map points: %w", err)
	}
	defer rows.Close()
	items := make([]RentalPropertyPoint, 0)
	for rows.Next() {
		var item RentalPropertyPoint
		if err := rows.Scan(&item.TransactionID, &item.CadastralMunicipalityCode,
			&item.BuildingNumber, &item.Longitude, &item.Latitude,
			&item.ContractDate, &item.PropertyGroup, &item.Area, &item.MonthlyRent,
			&item.MonthlyRentPerSQM, &item.IsRepresentative); err != nil {
			return nil, fmt.Errorf("scan rental map point: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *RentalStatisticsRepository) RentalOverview(
	ctx context.Context, filter StatisticsFilter,
) (RentalOverview, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return RentalOverview{}, err
	}
	query := fmt.Sprintf(`
		SELECT count(*)::bigint,
		  count(*) FILTER (WHERE is_quality_eligible)::bigint,
		  count(*) FILTER (WHERE representative_eligible)::bigint,
		  count(*) FILTER (WHERE is_quality_eligible AND NOT representative_eligible)::bigint,
		  count(monthly_rent_ex_vat) FILTER (WHERE representative_eligible)::bigint,
		  count(monthly_rent_per_sqm) FILTER (WHERE representative_eligible)::bigint,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY monthly_rent_ex_vat)
		    FILTER (WHERE representative_eligible)::float8,
		  avg(monthly_rent_ex_vat) FILTER (WHERE representative_eligible)::float8,
		  avg(monthly_rent_ex_vat) FILTER (WHERE is_quality_eligible)::float8,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY monthly_rent_per_sqm)
		    FILTER (WHERE representative_eligible)::float8,
		  avg(monthly_rent_per_sqm) FILTER (WHERE representative_eligible)::float8,
		  avg(monthly_rent_per_sqm) FILTER (WHERE is_quality_eligible)::float8,
		  percentile_cont(.5) WITHIN GROUP (ORDER BY area)
		    FILTER (WHERE representative_eligible)::float8
		FROM analytics.rental_facts fact
		WHERE %s`, where)
	var result RentalOverview
	err = r.db.QueryRow(ctx, query, args...).Scan(
		&result.TransactionCount, &result.EligibleCount, &result.IncludedSampleSize,
		&result.ExcludedOutlierCount, &result.MonthlyRentSampleSize,
		&result.RentPerSQMSampleSize, &result.MedianMonthlyRent,
		&result.CleanedAverageRent, &result.RawAverageRent,
		&result.MedianMonthlyRentPerSQM, &result.CleanedAveragePerSQM,
		&result.RawAveragePerSQM, &result.MedianArea)
	if err != nil {
		return RentalOverview{}, fmt.Errorf("rental overview statistics: %w", err)
	}
	applyPublicationPolicy(result.IncludedSampleSize,
		&result.IsPublishable, &result.SuppressionReason)
	return result, nil
}

func (r *RentalStatisticsRepository) RentalTimeSeries(
	ctx context.Context, filter StatisticsFilter, interval string,
) ([]RentalTimeSeriesPoint, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	unit, step := intervalSQL(interval)
	lag := map[string]int{"month": 12, "quarter": 4, "year": 1}[interval]
	query := fmt.Sprintf(`
		WITH periods AS (
		  SELECT date_trunc('%s',contract_date)::date period,
		    (date_trunc('%s',contract_date)+interval '%s'>(SELECT coalesce(max(r.analytics_rent_through), current_date::timestamptz) - interval '9 months' FROM analytics.analytical_releases r JOIN analytics.analytical_publication p ON r.id = p.active_release_id)) incomplete,
		    count(*)::bigint transaction_count,
		    count(*) FILTER (WHERE representative_eligible)::bigint sample_size,
		    percentile_cont(.5) WITHIN GROUP (ORDER BY monthly_rent_ex_vat)
		      FILTER (WHERE representative_eligible)::float8 median_rent,
		    percentile_cont(.5) WITHIN GROUP (ORDER BY monthly_rent_per_sqm)
		      FILTER (WHERE representative_eligible)::float8 median_per_sqm
		  FROM analytics.rental_facts fact
		  WHERE fact.contract_date IS NOT NULL AND %s
		  GROUP BY 1,2
		), compared AS (
		  SELECT *,
		    lag(sample_size,%d) OVER (ORDER BY period) previous_size,
		    lag(median_rent,%d) OVER (ORDER BY period) previous_rent,
		    lag(median_per_sqm,%d) OVER (ORDER BY period) previous_per_sqm,
		    lag(period,%d) OVER (ORDER BY period) previous_period
		  FROM periods
		)
		SELECT period,incomplete,transaction_count,sample_size,median_rent,
		  median_per_sqm,
		  CASE WHEN previous_period=period-interval '1 year' THEN previous_size END,
		  CASE WHEN previous_period=period-interval '1 year' THEN previous_rent END,
		  CASE WHEN previous_period=period-interval '1 year' THEN previous_per_sqm END,
		  CASE WHEN previous_period=period-interval '1 year' AND previous_rent>0
		    THEN 100*(median_rent/previous_rent-1) END,
		  CASE WHEN previous_period=period-interval '1 year' AND previous_per_sqm>0
		    THEN 100*(median_per_sqm/previous_per_sqm-1) END
		FROM compared ORDER BY period`,
		unit, unit, step, where, lag, lag, lag, lag)
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("rental time-series statistics: %w", err)
	}
	defer rows.Close()
	items := make([]RentalTimeSeriesPoint, 0)
	for rows.Next() {
		var period time.Time
		var item RentalTimeSeriesPoint
		if err := rows.Scan(&period, &item.Incomplete, &item.TransactionCount,
			&item.IncludedSampleSize, &item.MedianMonthlyRent,
			&item.MedianMonthlyRentPerSQM, &item.PreviousYearSampleSize,
			&item.PreviousYearMedianRent, &item.PreviousYearMedianPerSQM,
			&item.MonthlyRentYoYPercent, &item.RentPerSQMYoYPercent); err != nil {
			return nil, fmt.Errorf("scan rental time-series: %w", err)
		}
		item.Period = period.Format("2006-01-02")
		item.WeakComparisonSample = item.IncludedSampleSize < rentalWeakSampleThreshold ||
			item.PreviousYearSampleSize == nil ||
			*item.PreviousYearSampleSize < rentalWeakSampleThreshold
		applyPublicationPolicy(item.IncludedSampleSize,
			&item.IsPublishable, &item.SuppressionReason)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *RentalStatisticsRepository) RentalOutliers(
	ctx context.Context, filter StatisticsFilter, limit, offset int,
) ([]RentalOutlierRecord, int64, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, 0, err
	}
	query := fmt.Sprintf(`
		SELECT count(*) OVER ()::bigint,fact.transaction_id,fact.contract_date::text,
		  fact.property_group,fact.area::float8,fact.monthly_rent_ex_vat::float8,
		  fact.monthly_rent_per_sqm::float8,e.cohort_level,e.cohort_size,
		  e.cohort_median::float8,e.lower_bound::float8,e.upper_bound::float8,
		  e.modified_z_score::float8,e.rule_version
		FROM analytics.rental_facts fact
		JOIN analytics.rental_outlier_evaluations e USING(transaction_id)
		WHERE e.status='outlier' AND %s
		ORDER BY e.modified_z_score DESC NULLS LAST,fact.transaction_id
		LIMIT %s OFFSET %s`, where, args.add(limit), args.add(offset))
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list rental outliers: %w", err)
	}
	defer rows.Close()
	var total int64
	items := make([]RentalOutlierRecord, 0)
	for rows.Next() {
		var item RentalOutlierRecord
		if err := rows.Scan(&total, &item.TransactionID, &item.ContractDate,
			&item.PropertyGroup, &item.Area, &item.MonthlyRent,
			&item.MonthlyRentPerSQM, &item.CohortLevel, &item.CohortSize,
			&item.CohortMedian, &item.LowerBound, &item.UpperBound,
			&item.ModifiedZScore, &item.RuleVersion); err != nil {
			return nil, 0, fmt.Errorf("scan rental outlier: %w", err)
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}
