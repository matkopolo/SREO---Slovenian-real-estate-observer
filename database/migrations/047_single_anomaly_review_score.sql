-- One definition of the anomaly review score (weights were repeated in four SQL formulas and in the pipeline).
-- The two refresh functions are re-created from their live definitions with the formulas replaced; results are identical.
-- missingness_profiles is no longer built or served by any code and is dropped.

CREATE OR REPLACE FUNCTION analytics.anomaly_review_score(
  hard numeric, robust numeric, residual numeric, isolation numeric, duplicate numeric, spatial numeric
) RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT least(1.0, 0.35*coalesce(hard,0) + 0.20*coalesce(robust,0) + 0.20*coalesce(residual,0)
    + 0.10*coalesce(isolation,0) + 0.10*coalesce(duplicate,0) + 0.05*coalesce(spatial,0))::numeric
$$;

CREATE OR REPLACE FUNCTION analytics.refresh_anomaly_signals()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
AS $function$
DECLARE
    affected bigint;
    refresh_run_id bigint;
BEGIN
    INSERT INTO analytics.refresh_runs(process,status)
    VALUES ('anomaly_signals','running') RETURNING id INTO refresh_run_id;

    WITH sale_duplicates AS (
        SELECT transaction_id,count(*) OVER (
            PARTITION BY contract_date,property_group,area,price,
                         cadastral_municipality_code,building_number,
                         building_part_number
        ) duplicate_count
        FROM analytics.sale_facts
        WHERE contract_date IS NOT NULL AND area IS NOT NULL AND price IS NOT NULL
    ), rental_duplicates AS (
        SELECT transaction_id,count(*) OVER (
            PARTITION BY contract_date,property_group,area,monthly_rent_ex_vat,
                         cadastral_municipality_code,building_number,
                         building_part_number
        ) duplicate_count
        FROM analytics.rental_facts
        WHERE contract_date IS NOT NULL AND area IS NOT NULL
          AND monthly_rent_ex_vat IS NOT NULL
    ), raw_signals AS (
        SELECT 'sale'::text transaction_kind,f.transaction_id,
          array_cat(f.quality_reasons,array_remove(ARRAY[
            CASE WHEN e.status='outlier' THEN 'extreme_price_per_m2' END,
            CASE WHEN coalesce(d.duplicate_count,0)>1 THEN 'possible_duplicate' END,
            CASE WHEN f.location IS NULL THEN 'missing_coordinates' END,
            CASE WHEN f.location IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM analytics.geographic_units country
              WHERE country.level='country'
                AND ST_Covers(country.geometry_d96tm,f.location)
            ) THEN 'coordinate_outside_slovenia' END,
            CASE WHEN t.municipality_code IS NOT NULL AND municipality.code IS NOT NULL
                      AND t.municipality_code<>municipality.code
                 THEN 'coordinate_outside_municipality' END
          ],NULL)) flags,
          least(1.0,cardinality(f.quality_reasons)/2.0)::numeric hard_score,
          CASE WHEN e.status='outlier'
               THEN least(1.0,coalesce(e.modified_z_score,5)/10.0)
               ELSE 0 END::numeric robust_score,
          CASE WHEN coalesce(d.duplicate_count,0)>1 THEN 1 ELSE 0 END::numeric duplicate_score,
          CASE WHEN f.location IS NULL THEN 0.5
               WHEN t.municipality_code IS NOT NULL AND municipality.code IS NOT NULL
                    AND t.municipality_code<>municipality.code THEN 1
               WHEN NOT EXISTS (
                 SELECT 1 FROM analytics.geographic_units country
                 WHERE country.level='country'
                   AND ST_Covers(country.geometry_d96tm,f.location)
               ) THEN 1 ELSE 0 END::numeric spatial_score
        FROM analytics.sale_facts f
        JOIN transactions t USING(transaction_id)
        LEFT JOIN analytics.sale_outlier_evaluations e USING(transaction_id)
        LEFT JOIN sale_duplicates d USING(transaction_id)
        LEFT JOIN analytics.geographic_units municipality
          ON municipality.id=f.municipality_id
        UNION ALL
        SELECT 'rent',f.transaction_id,
          array_cat(f.quality_reasons,array_remove(ARRAY[
            CASE WHEN e.status='outlier' THEN 'extreme_price_per_m2' END,
            CASE WHEN coalesce(d.duplicate_count,0)>1 THEN 'possible_duplicate' END,
            CASE WHEN f.location IS NULL THEN 'missing_coordinates' END,
            CASE WHEN f.location IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM analytics.geographic_units country
              WHERE country.level='country'
                AND ST_Covers(country.geometry_d96tm,f.location)
            ) THEN 'coordinate_outside_slovenia' END
          ],NULL)),
          least(1.0,cardinality(f.quality_reasons)/2.0)::numeric,
          CASE WHEN e.status='outlier'
               THEN least(1.0,coalesce(e.modified_z_score,5)/10.0)
               ELSE 0 END::numeric,
          CASE WHEN coalesce(d.duplicate_count,0)>1 THEN 1 ELSE 0 END::numeric,
          CASE WHEN f.location IS NULL THEN 0.5
               WHEN NOT EXISTS (
                 SELECT 1 FROM analytics.geographic_units country
                 WHERE country.level='country'
                   AND ST_Covers(country.geometry_d96tm,f.location)
               ) THEN 1 ELSE 0 END::numeric
        FROM analytics.rental_facts f
        LEFT JOIN analytics.rental_outlier_evaluations e USING(transaction_id)
        LEFT JOIN rental_duplicates d USING(transaction_id)
    ), scored AS (
        SELECT *,analytics.anomaly_review_score(hard_score,robust_score,NULL,NULL,duplicate_score,spatial_score) AS review_score
        FROM raw_signals
    )
    INSERT INTO analytics.anomaly_signals(
        transaction_kind,transaction_id,flags,hard_rule_score,
        robust_cohort_score,duplicate_score,spatial_score,review_score,
        signal_version,evaluated_at
    )
    SELECT transaction_kind,transaction_id,flags,hard_score,robust_score,
           duplicate_score,spatial_score,review_score,'anomaly-signals-v1',now()
    FROM scored
    ON CONFLICT(transaction_kind,transaction_id) DO UPDATE SET
        flags=excluded.flags,
        hard_rule_score=excluded.hard_rule_score,
        robust_cohort_score=excluded.robust_cohort_score,
        duplicate_score=excluded.duplicate_score,
        spatial_score=excluded.spatial_score,
        review_score=excluded.review_score,
        signal_version=excluded.signal_version,
        evaluated_at=excluded.evaluated_at;

    GET DIAGNOSTICS affected=ROW_COUNT;

    DELETE FROM analytics.anomaly_signals signal
    WHERE (signal.transaction_kind='sale' AND NOT EXISTS (
        SELECT 1 FROM analytics.sale_facts f
        WHERE f.transaction_id=signal.transaction_id
    )) OR (signal.transaction_kind='rent' AND NOT EXISTS (
        SELECT 1 FROM analytics.rental_facts f
        WHERE f.transaction_id=signal.transaction_id
    ));

    ANALYZE analytics.anomaly_signals;
    UPDATE analytics.refresh_runs
    SET status='succeeded',finished_at=clock_timestamp(),
        details=jsonb_build_object('rows',affected,'signalVersion','anomaly-signals-v1')
    WHERE id=refresh_run_id;
    RETURN affected;
END
$function$;

CREATE OR REPLACE FUNCTION analytics.refresh_near_duplicate_candidates()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
AS $function$
DECLARE
    affected bigint;
BEGIN
    DELETE FROM analytics.near_duplicate_candidates;
    INSERT INTO analytics.near_duplicate_candidates
    WITH facts AS (
      SELECT 'sale'::text kind,transaction_id,contract_date,area,
        price amount,cadastral_municipality_code,building_number,
        building_part_number,property_group
      FROM analytics.sale_facts
      UNION ALL
      SELECT 'rent',transaction_id,contract_date,area,
        monthly_rent_ex_vat,cadastral_municipality_code,building_number,
        building_part_number,property_group
      FROM analytics.rental_facts
    )
    SELECT left_fact.kind,left_fact.transaction_id,right_fact.transaction_id,
      'same_building_part',
      abs(left_fact.contract_date-right_fact.contract_date),
      abs(left_fact.area-right_fact.area)/greatest(left_fact.area,right_fact.area),
      abs(left_fact.amount-right_fact.amount)/greatest(left_fact.amount,right_fact.amount),
      greatest(0,1-
        abs(left_fact.contract_date-right_fact.contract_date)/7.0-
        abs(left_fact.area-right_fact.area)/greatest(left_fact.area,right_fact.area)-
        abs(left_fact.amount-right_fact.amount)/greatest(left_fact.amount,right_fact.amount)
      ),
      'near-duplicate-v2',now()
    FROM facts left_fact
    JOIN facts right_fact
      ON right_fact.kind=left_fact.kind
     AND right_fact.transaction_id>left_fact.transaction_id
     AND right_fact.property_group=left_fact.property_group
     AND right_fact.cadastral_municipality_code=left_fact.cadastral_municipality_code
     AND right_fact.building_number=left_fact.building_number
     AND right_fact.building_part_number=left_fact.building_part_number
     AND right_fact.contract_date BETWEEN
         left_fact.contract_date-7 AND left_fact.contract_date+7
    WHERE left_fact.contract_date IS NOT NULL
      AND left_fact.area>0 AND right_fact.area>0
      AND left_fact.amount>0 AND right_fact.amount>0
      AND abs(left_fact.area-right_fact.area)/
          greatest(left_fact.area,right_fact.area)<=.02
      AND abs(left_fact.amount-right_fact.amount)/
          greatest(left_fact.amount,right_fact.amount)<=.02;
    GET DIAGNOSTICS affected=ROW_COUNT;

    UPDATE analytics.anomaly_signals
    SET duplicate_score=0,
        flags=array_remove(array_remove(flags,'possible_near_duplicate'),'possible_duplicate'),
        review_score=analytics.anomaly_review_score(hard_rule_score,robust_cohort_score,model_residual_score,isolation_forest_score,0,spatial_score);

    WITH exact_duplicates AS (
      SELECT 'sale'::text transaction_kind,transaction_id
      FROM (
        SELECT transaction_id,row_number() OVER (
          PARTITION BY contract_date,property_group,area,price,
                       cadastral_municipality_code,building_number,building_part_number
          ORDER BY transaction_id
        ) duplicate_position
        FROM analytics.sale_facts
        WHERE contract_date IS NOT NULL AND area IS NOT NULL AND price IS NOT NULL
      ) ranked WHERE duplicate_position>1
      UNION ALL
      SELECT 'rent',transaction_id
      FROM (
        SELECT transaction_id,row_number() OVER (
          PARTITION BY contract_date,property_group,area,monthly_rent_ex_vat,
                       cadastral_municipality_code,building_number,building_part_number
          ORDER BY transaction_id
        ) duplicate_position
        FROM analytics.rental_facts
        WHERE contract_date IS NOT NULL AND area IS NOT NULL
          AND monthly_rent_ex_vat IS NOT NULL
      ) ranked WHERE duplicate_position>1
    )
    UPDATE analytics.anomaly_signals signal
    SET duplicate_score=1,
        flags=array_append(signal.flags,'possible_duplicate'),
        review_score=analytics.anomaly_review_score(signal.hard_rule_score,signal.robust_cohort_score,signal.model_residual_score,signal.isolation_forest_score,1,signal.spatial_score)
    FROM exact_duplicates duplicate
    WHERE duplicate.transaction_kind=signal.transaction_kind
      AND duplicate.transaction_id=signal.transaction_id;

    UPDATE analytics.anomaly_signals signal
    SET duplicate_score=greatest(signal.duplicate_score,candidate.candidate_score),
        flags=CASE WHEN 'possible_near_duplicate'=ANY(signal.flags)
          THEN signal.flags ELSE array_append(signal.flags,'possible_near_duplicate') END,
        review_score=analytics.anomaly_review_score(signal.hard_rule_score,signal.robust_cohort_score,signal.model_residual_score,signal.isolation_forest_score,greatest(signal.duplicate_score,candidate.candidate_score),signal.spatial_score)
    FROM (
      SELECT transaction_kind,candidate_transaction_id transaction_id,
             max(candidate_score) candidate_score
      FROM analytics.near_duplicate_candidates
      GROUP BY 1,2
    ) candidate
    WHERE candidate.transaction_kind=signal.transaction_kind
      AND candidate.transaction_id=signal.transaction_id;
    ANALYZE analytics.near_duplicate_candidates;
    RETURN affected;
END
$function$;

DROP FUNCTION IF EXISTS analytics.refresh_missingness_profiles();
DROP TABLE IF EXISTS analytics.missingness_profiles;
