-- Explicit source for the six refresh functions whose live bodies were rewritten in
-- place by 040 (TRUNCATE replaced with DELETE through a regular expression over
-- pg_get_functiondef). Their files 011, 012, 014, 015, 020 and 021 still carry the
-- TRUNCATE versions, so re-applying one of those CREATE OR REPLACE blocks would silently
-- bring back an ACCESS EXCLUSIVE lock held for the whole release transaction. From now on
-- this file is the definition of record; CI fails when any analytics function body
-- contains TRUNCATE (database/checks/catalog.sql).
--
-- The bodies below are the live definitions, unchanged except for one setting: work_mem.
-- The Compose database now runs with a 16 MB global work_mem (sized for the API's ten
-- connections); the rebuilds keep the 64 MB per sort/hash node they were tuned with.
-- SECURITY DEFINER and the pinned search_path are stated here as in 047; roles.sql
-- re-applies them on every migration run.

CREATE OR REPLACE FUNCTION analytics.refresh_sale_facts()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
DECLARE
    imported_rows bigint;
    refresh_run_id bigint;
BEGIN
    INSERT INTO analytics.refresh_runs(process,status)
    VALUES ('sale_facts','running') RETURNING id INTO refresh_run_id;
    DELETE FROM analytics.sale_facts;

    INSERT INTO analytics.sale_facts (
        transaction_id,contract_date,dataset_year,property_group,
        building_part_count,land_parcel_count,primary_property_count,
        area,price,price_per_sqm,price_derivation,is_quality_eligible,
        quality_reasons,location,statistical_region_id,municipality_id,
        city_district_id,local_community_id,settlement_id
    )
    WITH building AS (
        SELECT
            bp.transaction_id,
            count(*)::integer AS component_count,
            count(*) FILTER (WHERE bp.contractual_price>0)::integer AS priced_count,
            sum(bp.contractual_price) FILTER (WHERE bp.contractual_price>0) AS component_price,
            array_remove(array_agg(DISTINCT bp.building_part_type),NULL) AS source_types,
            count(*) FILTER (WHERE type_group.is_primary)::integer AS primary_count,
            sum(coalesce(bp.sold_area,bp.sold_building_part_area,bp.sold_usable_area))
                FILTER (WHERE type_group.is_primary) AS primary_area,
            sum(coalesce(bp.sold_area,bp.sold_building_part_area,bp.sold_usable_area))
                FILTER (WHERE type_group.property_group='garage') AS garage_area,
            ST_Centroid(ST_Collect(bp.location)
                FILTER (WHERE type_group.is_primary AND bp.location IS NOT NULL)) AS primary_location,
            ST_Centroid(ST_Collect(bp.location)
                FILTER (WHERE bp.location IS NOT NULL)) AS any_location
        FROM building_parts bp
        LEFT JOIN analytics.building_part_type_groups type_group
          ON type_group.source_code=bp.building_part_type
        GROUP BY bp.transaction_id
    ),
    land AS (
        SELECT
            lp.transaction_id,
            count(*)::integer AS component_count,
            count(*) FILTER (WHERE lp.contractual_price>0)::integer AS priced_count,
            sum(lp.contractual_price) FILTER (WHERE lp.contractual_price>0) AS component_price,
            array_remove(array_agg(DISTINCT lp.land_type),NULL) AS source_types,
            sum(lp.parcel_area) FILTER (WHERE lp.parcel_area>0) AS land_area,
            ST_Centroid(ST_Collect(lp.location)
                FILTER (WHERE lp.location IS NOT NULL)) AS location
        FROM land_parcels lp
        GROUP BY lp.transaction_id
    ),
    packages AS (
        SELECT
            transaction.transaction_id,transaction.contract_date,
            transaction.dataset_year,transaction.contract_price,
            analytics.classify_sale_package(building.source_types,land.source_types) AS property_group,
            coalesce(building.component_count,0) AS building_part_count,
            coalesce(land.component_count,0) AS land_parcel_count,
            CASE
                WHEN coalesce(building.primary_count,0)>0 THEN building.primary_count
                WHEN coalesce(building.component_count,0)>0 THEN building.component_count
                ELSE coalesce(land.component_count,0)
            END AS primary_property_count,
            CASE analytics.classify_sale_package(building.source_types,land.source_types)
                WHEN 'house' THEN building.primary_area
                WHEN 'apartment' THEN building.primary_area
                WHEN 'commercial' THEN building.primary_area
                WHEN 'garage' THEN building.garage_area
                WHEN 'land' THEN land.land_area
            END AS area,
            coalesce(building.component_count,0)+coalesce(land.component_count,0) AS component_count,
            coalesce(building.priced_count,0)+coalesce(land.priced_count,0) AS priced_count,
            coalesce(building.component_price,0)+coalesce(land.component_price,0) AS component_price,
            coalesce(building.primary_location,building.any_location,land.location) AS location
        FROM transactions transaction
        LEFT JOIN building ON building.transaction_id=transaction.transaction_id
        LEFT JOIN land ON land.transaction_id=transaction.transaction_id
    ),
    priced AS (
        SELECT packages.*,
            CASE
                WHEN component_count>0 AND priced_count=component_count AND component_price>0
                    THEN component_price
                WHEN primary_property_count=1 AND property_group NOT IN ('mixed','unknown')
                     AND contract_price>0 THEN contract_price
            END AS analytical_price,
            CASE
                WHEN component_count>0 AND priced_count=component_count AND component_price>0
                    THEN 'component_prices'
                WHEN primary_property_count=1 AND property_group NOT IN ('mixed','unknown')
                     AND contract_price>0 THEN 'single_primary_transaction_price'
                ELSE 'unavailable'
            END AS price_derivation
        FROM packages
    ),
    qualified AS (
        SELECT priced.*,
            array_remove(ARRAY[
                CASE WHEN contract_date IS NULL THEN 'missing_contract_date'
                     WHEN contract_date<DATE '1900-01-01' OR contract_date>current_date
                     THEN 'invalid_contract_date' END,
                CASE WHEN area IS NULL OR area<=0 THEN 'missing_or_invalid_area' END,
                CASE WHEN analytical_price IS NULL OR analytical_price<=0
                     THEN 'missing_or_invalid_price' END,
                CASE WHEN property_group IN ('mixed','unknown')
                     THEN 'non_comparable_package' END
            ],NULL) AS quality_reasons
        FROM priced
    )
    SELECT
        qualified.transaction_id,qualified.contract_date,qualified.dataset_year,
        qualified.property_group,qualified.building_part_count,
        qualified.land_parcel_count,qualified.primary_property_count,
        qualified.area,qualified.analytical_price,
        CASE WHEN qualified.area>0 AND qualified.analytical_price>0
             THEN qualified.analytical_price/qualified.area END,
        qualified.price_derivation,
        cardinality(qualified.quality_reasons)=0,qualified.quality_reasons,
        qualified.location,municipality.parent_id,municipality.id,
        district.id,community.id,settlement.id
    FROM qualified
    LEFT JOIN LATERAL (
        SELECT id,parent_id FROM analytics.geographic_units
        WHERE level='settlement' AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) settlement ON true
    LEFT JOIN LATERAL (
        SELECT id FROM analytics.geographic_units
        WHERE level='municipality' AND settlement.id IS NULL
          AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) municipality_fb ON true
    LEFT JOIN analytics.geographic_units municipality
        ON municipality.id=coalesce(settlement.parent_id,municipality_fb.id)
    LEFT JOIN LATERAL (
        SELECT id FROM analytics.geographic_units
        WHERE level='city_district' AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) district ON true
    LEFT JOIN LATERAL (
        SELECT id FROM analytics.geographic_units
        WHERE level='local_community' AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) community ON true;

    GET DIAGNOSTICS imported_rows=ROW_COUNT;
    ANALYZE analytics.sale_facts;
    UPDATE analytics.refresh_runs
    SET status='succeeded',finished_at=clock_timestamp(),
        details=jsonb_build_object('rows',imported_rows)
    WHERE id=refresh_run_id;
    RETURN imported_rows;
END
$function$
;

CREATE OR REPLACE FUNCTION analytics.refresh_land_transaction_facts()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
DECLARE
    imported_rows bigint;
BEGIN
    DELETE FROM analytics.land_transaction_facts;
    INSERT INTO analytics.land_transaction_facts(
        transaction_id,parcel_count,land_type_codes,readiness_class,
        is_strict_buildable,is_broad_buildable,parcel_area,analytical_price,
        price_per_sqm,strict_parcel_count,broad_parcel_count,
        unknown_parcel_count
    )
    WITH parcels AS (
        SELECT lp.transaction_id,
          count(*)::integer parcel_count,
          array_agg(DISTINCT lp.land_type ORDER BY lp.land_type)
            FILTER (WHERE lp.land_type IS NOT NULL) land_type_codes,
          count(*) FILTER (WHERE lp.land_type IN (1,2))::integer strict_count,
          count(*) FILTER (WHERE lp.land_type IN (1,2,3))::integer broad_count,
          count(*) FILTER (WHERE lp.land_type IS NULL)::integer unknown_count
        FROM land_parcels lp
        GROUP BY lp.transaction_id
    )
    SELECT sf.transaction_id,p.parcel_count,
      coalesce(p.land_type_codes,ARRAY[]::integer[]),
      CASE
        WHEN p.unknown_count>0 OR cardinality(p.land_type_codes)=0 THEN 'unknown'
        WHEN p.strict_count=p.parcel_count
          AND p.land_type_codes=ARRAY[1] THEN 'building_permit'
        WHEN p.strict_count=p.parcel_count
          AND p.land_type_codes=ARRAY[2] THEN 'serviced_buildable'
        WHEN p.strict_count=p.parcel_count THEN 'strict_mixed'
        WHEN p.broad_count=p.parcel_count THEN 'broad_unverified'
        ELSE 'mixed_or_non_buildable'
      END,
      p.unknown_count=0 AND p.strict_count=p.parcel_count,
      p.unknown_count=0 AND p.broad_count=p.parcel_count,
      sf.area,sf.price,sf.price_per_sqm,
      p.strict_count,p.broad_count,p.unknown_count
    FROM analytics.sale_facts sf
    JOIN parcels p USING(transaction_id)
    WHERE sf.property_group='land';
    GET DIAGNOSTICS imported_rows=ROW_COUNT;
    ANALYZE analytics.land_transaction_facts;
    RETURN imported_rows;
END
$function$
;

CREATE OR REPLACE FUNCTION analytics.refresh_sale_outliers()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
DECLARE
    evaluated_rows bigint;
    refresh_run_id bigint;
BEGIN
    INSERT INTO analytics.refresh_runs(process,status)
    VALUES ('sale_outliers','running') RETURNING id INTO refresh_run_id;

    WITH attributes AS (
        SELECT
            bp.transaction_id,
            min(bp.cadastral_municipality_code) AS cadastral_municipality_code,
            min(bp.building_number) AS building_number,
            min(bp.building_part_number) AS building_part_number,
            min(bp.construction_year) AS construction_year
        FROM building_parts bp
        JOIN analytics.sale_facts fact ON fact.transaction_id=bp.transaction_id
        LEFT JOIN analytics.building_part_type_groups mapping
          ON mapping.source_code=bp.building_part_type
        WHERE (mapping.is_primary AND mapping.property_group=fact.property_group)
           OR (fact.property_group='garage' AND mapping.property_group='garage')
        GROUP BY bp.transaction_id
    )
    UPDATE analytics.sale_facts fact
    SET cadastral_municipality_code=attributes.cadastral_municipality_code,
        building_number=attributes.building_number,
        building_part_number=attributes.building_part_number,
        construction_year=attributes.construction_year
    FROM attributes
    WHERE attributes.transaction_id=fact.transaction_id;

    UPDATE analytics.sale_facts
    SET is_quality_eligible=false,
        quality_reasons=array_append(quality_reasons,'implausible_area_for_property_group')
    WHERE is_quality_eligible
      AND (
        (property_group='apartment' AND (area<10 OR area>1000))
        OR (property_group='house' AND (area<20 OR area>2000))
        OR (property_group='commercial' AND (area<5 OR area>50000))
        OR (property_group='garage' AND (area<2 OR area>200))
        OR (property_group='land' AND area<1)
      )
      AND NOT quality_reasons@>ARRAY['implausible_area_for_property_group']::text[];

    UPDATE analytics.sale_facts
    SET is_quality_eligible=false,
        quality_reasons=array_append(quality_reasons,'implausible_price_per_sqm')
    WHERE is_quality_eligible
      AND (
        (property_group='apartment' AND (price_per_sqm<100 OR price_per_sqm>50000))
        OR (property_group='house' AND (price_per_sqm<20 OR price_per_sqm>50000))
        OR (property_group='commercial' AND (price_per_sqm<10 OR price_per_sqm>100000))
        OR (property_group='garage' AND (price_per_sqm<20 OR price_per_sqm>50000))
      )
      AND NOT quality_reasons@>ARRAY['implausible_price_per_sqm']::text[];

    DROP TABLE IF EXISTS pg_temp.sale_outlier_base;
    CREATE TEMP TABLE sale_outlier_base ON COMMIT DROP AS
    SELECT
        transaction_id,property_group,price_per_sqm,municipality_id,
        statistical_region_id,cadastral_municipality_code,building_number,
        floor(area/20.0)*20 AS area_band,
        extract(year FROM contract_date)::integer AS contract_year
    FROM analytics.sale_facts
    WHERE is_quality_eligible AND price_per_sqm>0
      AND property_group IN ('apartment','house','commercial','garage');
    CREATE INDEX ON sale_outlier_base
        (cadastral_municipality_code,building_number,property_group,area_band,contract_year);
    CREATE INDEX ON sale_outlier_base
        (municipality_id,property_group,area_band,contract_year);
    CREATE INDEX ON sale_outlier_base
        (statistical_region_id,property_group,area_band,contract_year);

    DROP TABLE IF EXISTS pg_temp.sale_outlier_building;
    CREATE TEMP TABLE sale_outlier_building ON COMMIT DROP AS
    SELECT
        cadastral_municipality_code,building_number,property_group,area_band,contract_year,
        count(*)::integer AS cohort_size,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY price_per_sqm) AS q1,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm) AS median,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY price_per_sqm) AS q3,
        NULL::numeric AS mad
    FROM sale_outlier_base
    WHERE cadastral_municipality_code IS NOT NULL AND building_number IS NOT NULL
    GROUP BY 1,2,3,4,5;
    UPDATE sale_outlier_building summary
    SET mad=deviation.mad
    FROM (
        SELECT
            base.cadastral_municipality_code,base.building_number,
            base.property_group,base.area_band,base.contract_year,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY abs(base.price_per_sqm-summary_inner.median)
            ) AS mad
        FROM sale_outlier_base base
        JOIN sale_outlier_building summary_inner
          USING (cadastral_municipality_code,building_number,property_group,area_band,contract_year)
        GROUP BY 1,2,3,4,5
    ) deviation
    WHERE summary.cadastral_municipality_code=deviation.cadastral_municipality_code
      AND summary.building_number=deviation.building_number
      AND summary.property_group=deviation.property_group
      AND summary.area_band=deviation.area_band
      AND summary.contract_year=deviation.contract_year;

    DROP TABLE IF EXISTS pg_temp.sale_outlier_municipality;
    CREATE TEMP TABLE sale_outlier_municipality ON COMMIT DROP AS
    SELECT
        municipality_id,property_group,area_band,contract_year,
        count(*)::integer AS cohort_size,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY price_per_sqm) AS q1,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm) AS median,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY price_per_sqm) AS q3,
        NULL::numeric AS mad
    FROM sale_outlier_base
    WHERE municipality_id IS NOT NULL
    GROUP BY 1,2,3,4;
    UPDATE sale_outlier_municipality summary
    SET mad=deviation.mad
    FROM (
        SELECT
            base.municipality_id,base.property_group,base.area_band,base.contract_year,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY abs(base.price_per_sqm-summary_inner.median)
            ) AS mad
        FROM sale_outlier_base base
        JOIN sale_outlier_municipality summary_inner
          USING (municipality_id,property_group,area_band,contract_year)
        GROUP BY 1,2,3,4
    ) deviation
    WHERE summary.municipality_id=deviation.municipality_id
      AND summary.property_group=deviation.property_group
      AND summary.area_band=deviation.area_band
      AND summary.contract_year=deviation.contract_year;

    DROP TABLE IF EXISTS pg_temp.sale_outlier_region;
    CREATE TEMP TABLE sale_outlier_region ON COMMIT DROP AS
    SELECT
        statistical_region_id,property_group,area_band,contract_year,
        count(*)::integer AS cohort_size,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY price_per_sqm) AS q1,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm) AS median,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY price_per_sqm) AS q3,
        NULL::numeric AS mad
    FROM sale_outlier_base
    WHERE statistical_region_id IS NOT NULL
    GROUP BY 1,2,3,4;
    UPDATE sale_outlier_region summary
    SET mad=deviation.mad
    FROM (
        SELECT
            base.statistical_region_id,base.property_group,base.area_band,base.contract_year,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY abs(base.price_per_sqm-summary_inner.median)
            ) AS mad
        FROM sale_outlier_base base
        JOIN sale_outlier_region summary_inner
          USING (statistical_region_id,property_group,area_band,contract_year)
        GROUP BY 1,2,3,4
    ) deviation
    WHERE summary.statistical_region_id=deviation.statistical_region_id
      AND summary.property_group=deviation.property_group
      AND summary.area_band=deviation.area_band
      AND summary.contract_year=deviation.contract_year;

    DELETE FROM analytics.sale_outlier_evaluations;
    INSERT INTO analytics.sale_outlier_evaluations (
        transaction_id,status,method,cohort_level,cohort_size,cohort_median,
        lower_bound,upper_bound,modified_z_score,rule_version,reasons
    )
    SELECT
        fact.transaction_id,
        CASE
            WHEN NOT fact.is_quality_eligible THEN 'ineligible'
            WHEN base.transaction_id IS NULL THEN 'insufficient_cohort'
            WHEN chosen.cohort_size IS NULL THEN 'insufficient_cohort'
            WHEN analytics.is_statistical_outlier(
                fact.price_per_sqm,chosen.q1::numeric,chosen.q3::numeric,
                chosen.median::numeric,chosen.mad::numeric
            ) THEN 'outlier'
            ELSE 'inlier'
        END,
        CASE WHEN chosen.cohort_size IS NOT NULL THEN 'iqr_and_mad' END,
        chosen.cohort_level,chosen.cohort_size,chosen.median,
        chosen.q1-1.5*greatest(chosen.q3-chosen.q1,abs(chosen.median)*0.20),
        chosen.q3+1.5*greatest(chosen.q3-chosen.q1,abs(chosen.median)*0.20),
        CASE WHEN chosen.median>0
             THEN 0.6745*abs(fact.price_per_sqm-chosen.median)
                  /greatest(chosen.mad,abs(chosen.median)*0.10) END,
        'sale-outlier-v2',
        CASE
            WHEN NOT fact.is_quality_eligible THEN fact.quality_reasons
            WHEN base.transaction_id IS NULL THEN ARRAY['unsupported_or_missing_comparable']::text[]
            WHEN chosen.cohort_size IS NULL THEN ARRAY['insufficient_comparable_cohort']::text[]
            WHEN analytics.is_statistical_outlier(
                fact.price_per_sqm,chosen.q1::numeric,chosen.q3::numeric,
                chosen.median::numeric,chosen.mad::numeric
            ) THEN ARRAY['statistically_atypical_price_per_sqm']::text[]
            ELSE ARRAY[]::text[]
        END
    FROM analytics.sale_facts fact
    LEFT JOIN sale_outlier_base base USING (transaction_id)
    LEFT JOIN sale_outlier_building building
      ON building.cadastral_municipality_code=base.cadastral_municipality_code
     AND building.building_number=base.building_number
     AND building.property_group=base.property_group
     AND building.area_band=base.area_band
     AND building.contract_year=base.contract_year
    LEFT JOIN sale_outlier_municipality municipality
      ON municipality.municipality_id=base.municipality_id
     AND municipality.property_group=base.property_group
     AND municipality.area_band=base.area_band
     AND municipality.contract_year=base.contract_year
    LEFT JOIN sale_outlier_region region
      ON region.statistical_region_id=base.statistical_region_id
     AND region.property_group=base.property_group
     AND region.area_band=base.area_band
     AND region.contract_year=base.contract_year
    LEFT JOIN LATERAL (
        SELECT *
        FROM (
            SELECT 'building'::text AS cohort_level,building.cohort_size,
                   building.q1,building.median,building.q3,building.mad,1 AS priority
            WHERE building.cohort_size>=5
            UNION ALL
            SELECT 'municipality_year',municipality.cohort_size,
                   municipality.q1,municipality.median,municipality.q3,municipality.mad,2
            WHERE municipality.cohort_size>=15
            UNION ALL
            SELECT 'statistical_region_year',region.cohort_size,
                   region.q1,region.median,region.q3,region.mad,3
            WHERE region.cohort_size>=30
        ) cohorts ORDER BY priority LIMIT 1
    ) chosen ON true;

    UPDATE analytics.sale_facts fact
    SET representative_eligible=(
        fact.is_quality_eligible AND evaluation.status<>'outlier'
    )
    FROM analytics.sale_outlier_evaluations evaluation
    WHERE evaluation.transaction_id=fact.transaction_id;

    GET DIAGNOSTICS evaluated_rows=ROW_COUNT;
    ANALYZE analytics.sale_facts;
    ANALYZE analytics.sale_outlier_evaluations;
    UPDATE analytics.refresh_runs
    SET status='succeeded',finished_at=clock_timestamp(),
        details=jsonb_build_object('rows',evaluated_rows,'ruleVersion','sale-outlier-v2')
    WHERE id=refresh_run_id;
    RETURN evaluated_rows;
END
$function$
;

CREATE OR REPLACE FUNCTION analytics.refresh_rental_facts()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
DECLARE
    imported_rows bigint;
    refresh_run_id bigint;
BEGIN
    INSERT INTO analytics.refresh_runs(process,status)
    VALUES ('rental_facts','running') RETURNING id INTO refresh_run_id;
    DELETE FROM analytics.rental_facts;

    INSERT INTO analytics.rental_facts (
        transaction_id,contract_date,rental_start_date,rental_end_date,dataset_year,
        property_group,space_count,area,monthly_rent_reported,monthly_rent_ex_vat,
        monthly_rent_per_sqm,rent_derivation,rental_term,duration_months,
        operating_costs_included,rental_transaction_type,is_market_rent,
        is_quality_eligible,representative_eligible,quality_reasons,
        cadastral_municipality_code,building_number,building_part_number,
        construction_year,location,statistical_region_id,municipality_id,
        city_district_id,local_community_id,settlement_id
    )
    WITH spaces AS (
        SELECT
            part.transaction_id,
            count(*)::integer AS space_count,
            count(*) FILTER(WHERE part.contractual_rent>0)::integer AS priced_count,
            sum(part.contractual_rent) FILTER(WHERE part.contractual_rent>0) AS component_rent,
            array_remove(array_agg(DISTINCT part.rented_spaces_type),NULL) AS source_types,
            sum(coalesce(part.rented_spaces_area,part.rented_usable_area))
                FILTER(WHERE coalesce(part.rented_spaces_area,part.rented_usable_area)>0) AS area,
            min(part.cadastral_municipality_code) AS cadastral_municipality_code,
            min(part.building_number) AS building_number,
            min(part.building_part_number) AS building_part_number,
            min(part.construction_year) AS construction_year,
            ST_Centroid(ST_Collect(part.location)
                FILTER(WHERE part.location IS NOT NULL)) AS location
        FROM rental_building_parts part
        GROUP BY part.transaction_id
    ),
    packages AS (
        SELECT
            transaction.transaction_id,transaction.contract_date,
            transaction.rental_start_date,transaction.rental_end_date,
            transaction.dataset_year,transaction.contract_rent,
            transaction.vat_included,transaction.vat_rate,
            transaction.rental_time,transaction.rental_duration,
            transaction.operating_costs_included,transaction.rental_transaction_type,
            analytics.classify_rental_package(spaces.source_types) AS property_group,
            coalesce(spaces.space_count,0) AS space_count,spaces.area,
            spaces.cadastral_municipality_code,spaces.building_number,
            spaces.building_part_number,spaces.construction_year,spaces.location,
            CASE
                WHEN spaces.space_count>0 AND spaces.priced_count=spaces.space_count
                     AND spaces.component_rent>0 THEN spaces.component_rent
                WHEN analytics.classify_rental_package(spaces.source_types)
                     NOT IN ('mixed','unknown') AND transaction.contract_rent>0
                    THEN transaction.contract_rent
            END AS reported_rent,
            CASE
                WHEN spaces.space_count>0 AND spaces.priced_count=spaces.space_count
                     AND spaces.component_rent>0 THEN 'component_rents'
                WHEN analytics.classify_rental_package(spaces.source_types)
                     NOT IN ('mixed','unknown') AND transaction.contract_rent>0
                    THEN 'homogeneous_transaction_rent'
                ELSE 'unavailable'
            END AS rent_derivation
        FROM rental_transactions transaction
        LEFT JOIN spaces USING(transaction_id)
    ),
    normalized AS (
        SELECT packages.*,
            CASE
                WHEN vat_included IS NOT TRUE THEN reported_rent
                WHEN vat_rate=1 THEN reported_rent/1.085
                WHEN vat_rate=2 THEN reported_rent/1.20
                WHEN vat_rate=3 THEN reported_rent/1.095
                WHEN vat_rate=4 THEN reported_rent/1.22
            END AS rent_ex_vat,
            CASE rental_time WHEN '1' THEN 'fixed'
                             WHEN '2' THEN 'indefinite'
                             ELSE 'unknown' END AS rental_term,
            CASE WHEN rental_time='1' AND rental_duration~'^[0-9]+$'
                 THEN rental_duration::integer END AS duration_months
        FROM packages
    ),
    qualified AS (
        SELECT normalized.*,
            array_remove(ARRAY[
                CASE WHEN contract_date IS NULL THEN 'missing_contract_date'
                     WHEN contract_date<DATE '1900-01-01' OR contract_date>current_date
                     THEN 'invalid_contract_date' END,
                CASE WHEN rental_transaction_type<>1 THEN 'non_market_rent' END,
                CASE WHEN property_group IN ('mixed','unknown')
                     THEN 'non_comparable_package' END,
                CASE WHEN area IS NULL OR area<=0 THEN 'missing_or_invalid_area' END,
                CASE WHEN rent_ex_vat IS NULL OR rent_ex_vat<=0
                     THEN 'missing_or_invalid_monthly_rent' END,
                CASE WHEN vat_included IS TRUE AND vat_rate NOT IN (1,2,3,4)
                     THEN 'unknown_vat_rate' END,
                CASE WHEN rental_term='fixed'
                          AND (duration_months IS NULL OR duration_months<6)
                     THEN 'invalid_fixed_term_duration' END,
                CASE
                    WHEN property_group='apartment' AND (area<10 OR area>300)
                        THEN 'implausible_area_for_property_group'
                    WHEN property_group='room' AND (area<5 OR area>100)
                        THEN 'implausible_area_for_property_group'
                    WHEN property_group='house' AND (area<20 OR area>2000)
                        THEN 'implausible_area_for_property_group'
                    WHEN property_group='garage' AND (area<2 OR area>200)
                        THEN 'implausible_area_for_property_group'
                    WHEN property_group='commercial' AND (area<5 OR area>50000)
                        THEN 'implausible_area_for_property_group' END,
                CASE
                    WHEN property_group='apartment'
                         AND (rent_ex_vat<10 OR rent_ex_vat>10000
                              OR rent_ex_vat/NULLIF(area,0)<1
                              OR rent_ex_vat/NULLIF(area,0)>50)
                        THEN 'implausible_rent_for_property_group'
                    WHEN property_group='room'
                         AND (rent_ex_vat<10 OR rent_ex_vat>5000
                              OR rent_ex_vat/NULLIF(area,0)<1
                              OR rent_ex_vat/NULLIF(area,0)>100)
                        THEN 'implausible_rent_for_property_group'
                    WHEN property_group IN ('house','garage','commercial')
                         AND (rent_ex_vat/NULLIF(area,0)<0.1
                              OR rent_ex_vat/NULLIF(area,0)>500)
                        THEN 'implausible_rent_for_property_group' END
            ],NULL) AS reasons
        FROM normalized
    )
    SELECT
        qualified.transaction_id,qualified.contract_date,
        qualified.rental_start_date,qualified.rental_end_date,qualified.dataset_year,
        qualified.property_group,qualified.space_count,qualified.area,
        qualified.reported_rent,qualified.rent_ex_vat,
        qualified.rent_ex_vat/NULLIF(qualified.area,0),qualified.rent_derivation,
        qualified.rental_term,qualified.duration_months,
        qualified.operating_costs_included,qualified.rental_transaction_type,
        qualified.rental_transaction_type=1,
        cardinality(qualified.reasons)=0,cardinality(qualified.reasons)=0,
        qualified.reasons,qualified.cadastral_municipality_code,
        qualified.building_number,qualified.building_part_number,
        qualified.construction_year,qualified.location,
        municipality.parent_id,municipality.id,
        district.id,community.id,settlement.id
    FROM qualified
    LEFT JOIN LATERAL (
        SELECT id,parent_id FROM analytics.geographic_units
        WHERE level='settlement' AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) settlement ON true
    LEFT JOIN LATERAL (
        SELECT id FROM analytics.geographic_units
        WHERE level='municipality' AND settlement.id IS NULL
          AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) municipality_fb ON true
    LEFT JOIN analytics.geographic_units municipality
        ON municipality.id=coalesce(settlement.parent_id,municipality_fb.id)
    LEFT JOIN LATERAL (
        SELECT id FROM analytics.geographic_units
        WHERE level='city_district' AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) district ON true
    LEFT JOIN LATERAL (
        SELECT id FROM analytics.geographic_units
        WHERE level='local_community' AND qualified.location IS NOT NULL
          AND ST_Covers(geometry_d96tm,qualified.location)
        ORDER BY ST_Area(geometry_d96tm),id LIMIT 1
    ) community ON true;

    GET DIAGNOSTICS imported_rows=ROW_COUNT;
    ANALYZE analytics.rental_facts;
    UPDATE analytics.refresh_runs
    SET status='succeeded',finished_at=clock_timestamp(),
        details=jsonb_build_object('rows',imported_rows,'ruleVersion','rental-facts-v1')
    WHERE id=refresh_run_id;
    RETURN imported_rows;
END
$function$
;

CREATE OR REPLACE FUNCTION analytics.refresh_rental_outliers()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
DECLARE
    evaluated_rows bigint;
    refresh_run_id bigint;
BEGIN
    INSERT INTO analytics.refresh_runs(process,status)
    VALUES ('rental_outliers','running') RETURNING id INTO refresh_run_id;

    DROP TABLE IF EXISTS pg_temp.rental_outlier_base;
    CREATE TEMP TABLE rental_outlier_base ON COMMIT DROP AS
    SELECT
        transaction_id,property_group,monthly_rent_per_sqm,municipality_id,
        statistical_region_id,floor(area/20.0)*20 AS area_band,
        extract(year FROM contract_date)::integer AS contract_year
    FROM analytics.rental_facts
    WHERE is_quality_eligible AND monthly_rent_per_sqm>0;
    CREATE INDEX ON rental_outlier_base
        (municipality_id,property_group,area_band,contract_year);
    CREATE INDEX ON rental_outlier_base
        (statistical_region_id,property_group,area_band,contract_year);

    DROP TABLE IF EXISTS pg_temp.rental_outlier_municipality;
    CREATE TEMP TABLE rental_outlier_municipality ON COMMIT DROP AS
    SELECT
        municipality_id,property_group,area_band,contract_year,
        count(*)::integer AS cohort_size,
        percentile_cont(0.25) WITHIN GROUP(ORDER BY monthly_rent_per_sqm) AS q1,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY monthly_rent_per_sqm) AS median,
        percentile_cont(0.75) WITHIN GROUP(ORDER BY monthly_rent_per_sqm) AS q3
    FROM rental_outlier_base
    WHERE municipality_id IS NOT NULL
    GROUP BY 1,2,3,4;

    DROP TABLE IF EXISTS pg_temp.rental_outlier_region;
    CREATE TEMP TABLE rental_outlier_region ON COMMIT DROP AS
    SELECT
        statistical_region_id,property_group,area_band,contract_year,
        count(*)::integer AS cohort_size,
        percentile_cont(0.25) WITHIN GROUP(ORDER BY monthly_rent_per_sqm) AS q1,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY monthly_rent_per_sqm) AS median,
        percentile_cont(0.75) WITHIN GROUP(ORDER BY monthly_rent_per_sqm) AS q3
    FROM rental_outlier_base
    WHERE statistical_region_id IS NOT NULL
    GROUP BY 1,2,3,4;

    DELETE FROM analytics.rental_outlier_evaluations;
    INSERT INTO analytics.rental_outlier_evaluations(
        transaction_id,status,method,cohort_level,cohort_size,cohort_median,
        lower_bound,upper_bound,modified_z_score,rule_version,reasons
    )
    SELECT
        fact.transaction_id,
        CASE
            WHEN NOT fact.is_quality_eligible THEN 'ineligible'
            WHEN chosen.cohort_size IS NULL THEN 'insufficient_cohort'
            WHEN analytics.is_statistical_outlier(
                fact.monthly_rent_per_sqm,chosen.q1::numeric,chosen.q3::numeric,
                chosen.median::numeric,
                ((chosen.q3-chosen.q1)/1.349)::numeric
            ) THEN 'outlier'
            ELSE 'inlier'
        END,
        CASE WHEN chosen.cohort_size IS NOT NULL THEN 'iqr_and_approximate_mad' END,
        chosen.cohort_level,chosen.cohort_size,chosen.median,
        chosen.q1-1.5*greatest(chosen.q3-chosen.q1,abs(chosen.median)*0.20),
        chosen.q3+1.5*greatest(chosen.q3-chosen.q1,abs(chosen.median)*0.20),
        CASE WHEN chosen.median>0 THEN
            0.6745*abs(fact.monthly_rent_per_sqm-chosen.median)
            /greatest((chosen.q3-chosen.q1)/1.349,abs(chosen.median)*0.10)
        END,
        'rental-outlier-v1',
        CASE
            WHEN NOT fact.is_quality_eligible THEN fact.quality_reasons
            WHEN chosen.cohort_size IS NULL
                THEN ARRAY['insufficient_comparable_cohort']::text[]
            WHEN analytics.is_statistical_outlier(
                fact.monthly_rent_per_sqm,chosen.q1::numeric,chosen.q3::numeric,
                chosen.median::numeric,
                ((chosen.q3-chosen.q1)/1.349)::numeric
            ) THEN ARRAY['statistically_atypical_monthly_rent_per_sqm']::text[]
            ELSE ARRAY[]::text[]
        END
    FROM analytics.rental_facts fact
    LEFT JOIN rental_outlier_base base USING(transaction_id)
    LEFT JOIN rental_outlier_municipality municipality
      ON municipality.municipality_id=base.municipality_id
     AND municipality.property_group=base.property_group
     AND municipality.area_band=base.area_band
     AND municipality.contract_year=base.contract_year
    LEFT JOIN rental_outlier_region region
      ON region.statistical_region_id=base.statistical_region_id
     AND region.property_group=base.property_group
     AND region.area_band=base.area_band
     AND region.contract_year=base.contract_year
    LEFT JOIN LATERAL (
        SELECT *
        FROM (
            SELECT 'municipality_year'::text AS cohort_level,
                   municipality.cohort_size,municipality.q1,
                   municipality.median,municipality.q3,1 AS priority
            WHERE municipality.cohort_size>=15
            UNION ALL
            SELECT 'statistical_region_year',region.cohort_size,region.q1,
                   region.median,region.q3,2
            WHERE region.cohort_size>=30
        ) cohorts ORDER BY priority LIMIT 1
    ) chosen ON true;

    UPDATE analytics.rental_facts fact
    SET representative_eligible=(
        fact.is_quality_eligible AND evaluation.status<>'outlier'
    )
    FROM analytics.rental_outlier_evaluations evaluation
    WHERE evaluation.transaction_id=fact.transaction_id;

    GET DIAGNOSTICS evaluated_rows=ROW_COUNT;
    ANALYZE analytics.rental_facts;
    ANALYZE analytics.rental_outlier_evaluations;
    UPDATE analytics.refresh_runs
    SET status='succeeded',finished_at=clock_timestamp(),
        details=jsonb_build_object(
            'rows',evaluated_rows,'ruleVersion','rental-outlier-v1'
        )
    WHERE id=refresh_run_id;
    RETURN evaluated_rows;
END
$function$
;

CREATE OR REPLACE FUNCTION analytics.refresh_repeat_sales_indices()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'analytics', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
DECLARE
    inserted bigint;
    run_id uuid;
BEGIN
    DELETE FROM analytics.repeat_sale_pairs;
    INSERT INTO analytics.repeat_sale_pairs
    WITH ordered AS (
        SELECT transaction_id,property_group,contract_date,price_per_sqm,
          cadastral_municipality_code,building_number,building_part_number,
          lag(transaction_id) OVER identity_order previous_transaction_id,
          lag(contract_date) OVER identity_order previous_date,
          lag(price_per_sqm) OVER identity_order previous_price_per_sqm
        FROM analytics.sale_facts_strict_land
        WHERE representative_eligible
          AND property_group IN ('apartment','commercial','garage')
          AND cadastral_municipality_code IS NOT NULL
          AND building_number IS NOT NULL AND building_part_number IS NOT NULL
          AND contract_date IS NOT NULL AND price_per_sqm>0
        WINDOW identity_order AS (
          PARTITION BY cadastral_municipality_code,building_number,building_part_number
          ORDER BY contract_date,transaction_id
        )
    )
    SELECT transaction_id,previous_transaction_id,property_group,contract_date,
      previous_date,price_per_sqm,previous_price_per_sqm,
      (contract_date-previous_date)/365.2425,
      ln(price_per_sqm/previous_price_per_sqm)/
        ((contract_date-previous_date)/365.2425),
      cadastral_municipality_code,building_number,building_part_number
    FROM ordered
    WHERE previous_transaction_id IS NOT NULL
      AND contract_date>previous_date
      AND contract_date-previous_date>=180
      AND price_per_sqm/previous_price_per_sqm BETWEEN 0.1 AND 10;

    INSERT INTO analytics.index_calculation_runs(
        transaction_kind,method,methodology_version,data_from,data_to,parameters
    )
    SELECT 'sale','matched_pair_median','matched-pair-median-v2',
      min(previous_contract_date),max(current_contract_date),
      '{"minimumPairs":30,"uncertainty":"pair_return_quantiles","nominalCoverage":0.95}'::jsonb
    FROM analytics.repeat_sale_pairs
    RETURNING id INTO run_id;

    INSERT INTO analytics.market_indices(
        transaction_kind,method,property_group,geography_id,period,index_value,
        sample_size,base_period,methodology_version,calculation_run_id,
        observed_sample_size,lower_index_value,upper_index_value,
        nominal_coverage,uncertainty_method,is_publishable,suppression_reason
    )
    WITH annual AS (
      SELECT property_group,date_trunc('year',current_contract_date)::date period,
        percentile_cont(.5) WITHIN GROUP(ORDER BY annualized_log_return) growth,
        percentile_cont(.025) WITHIN GROUP(ORDER BY annualized_log_return) low_growth,
        percentile_cont(.975) WITHIN GROUP(ORDER BY annualized_log_return) high_growth,
        count(*)::integer observed
      FROM analytics.repeat_sale_pairs GROUP BY 1,2
    ), accumulated AS (
      SELECT *,
        sum(growth) OVER (PARTITION BY property_group ORDER BY period) cumulative,
        sum(low_growth) OVER (PARTITION BY property_group ORDER BY period) low_cumulative,
        sum(high_growth) OVER (PARTITION BY property_group ORDER BY period) high_cumulative,
        min(period) OVER(PARTITION BY property_group) base_period
      FROM annual
    )
    SELECT 'sale','matched_pair_median',property_group,NULL,period,
      exp(cumulative-first_value(cumulative) OVER group_order)*100,
      observed,base_period,'matched-pair-median-v2',run_id,observed,
      exp(low_cumulative-first_value(low_cumulative) OVER group_order)*100,
      exp(high_cumulative-first_value(high_cumulative) OVER group_order)*100,
      .95,'empirical_pair_return_quantiles',observed>=30,
      CASE WHEN observed<30 THEN 'below_minimum_pair_count_30' END
    FROM accumulated
    WINDOW group_order AS (PARTITION BY property_group ORDER BY period);
    GET DIAGNOSTICS inserted=ROW_COUNT;
    ANALYZE analytics.repeat_sale_pairs;
    ANALYZE analytics.market_indices;
    RETURN inserted;
END
$function$
;


-- The two functions re-created by 047 keep their definitions; they only get the same
-- work_mem setting (ALTER FUNCTION ... SET leaves the other settings untouched).
ALTER FUNCTION analytics.refresh_anomaly_signals() SET work_mem TO '64MB';
ALTER FUNCTION analytics.refresh_near_duplicate_candidates() SET work_mem TO '64MB';
