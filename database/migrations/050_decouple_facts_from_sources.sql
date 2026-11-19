-- Facts are derived data. The release transaction rebuilds analytics.sale_facts and
-- analytics.rental_facts as a whole (refresh_sale_facts and refresh_rental_facts begin
-- with DELETE FROM the fact table and re-insert one row per source transaction), and the
-- publication pointer flips in that same transaction. Source archives, however, are
-- imported and committed one by one before the release transaction starts, and the GURS
-- boundary sync commits on its own as well.
--
-- The foreign keys from the fact tables to public.transactions / public.rental_transactions
-- (ON DELETE CASCADE) and to analytics.geographic_units (ON DELETE SET NULL, CASCADE for
-- market_indices) therefore removed or blanked published facts the moment a re-imported
-- year or a replaced boundary committed: readers lost the current and previous year for
-- the 20-50 minutes until the new release was published, and the cascade also fired one
-- referential-integrity scan per deleted row.
--
-- Dropping them restores the atomic-publication guarantee: committed fact rows now change
-- only inside the release transaction. Referential integrity between facts and sources is
-- an invariant of the refresh functions (every fact row is derived from a source row in
-- the same transaction, and stale facts cannot survive because the functions delete the
-- whole table first), not of the catalog. Foreign keys that stay inside the analytics
-- schema are kept: outlier evaluations, land facts and repeat-sale pairs reference
-- sale_facts/rental_facts, model publications reference model runs, geographic_units
-- references itself.
ALTER TABLE analytics.sale_facts
    DROP CONSTRAINT IF EXISTS sale_facts_transaction_id_fkey,
    DROP CONSTRAINT IF EXISTS sale_facts_statistical_region_id_fkey,
    DROP CONSTRAINT IF EXISTS sale_facts_municipality_id_fkey,
    DROP CONSTRAINT IF EXISTS sale_facts_city_district_id_fkey,
    DROP CONSTRAINT IF EXISTS sale_facts_local_community_id_fkey,
    DROP CONSTRAINT IF EXISTS sale_facts_settlement_id_fkey;

ALTER TABLE analytics.rental_facts
    DROP CONSTRAINT IF EXISTS rental_facts_transaction_id_fkey,
    DROP CONSTRAINT IF EXISTS rental_facts_statistical_region_id_fkey,
    DROP CONSTRAINT IF EXISTS rental_facts_municipality_id_fkey,
    DROP CONSTRAINT IF EXISTS rental_facts_city_district_id_fkey,
    DROP CONSTRAINT IF EXISTS rental_facts_local_community_id_fkey,
    DROP CONSTRAINT IF EXISTS rental_facts_settlement_id_fkey;

ALTER TABLE analytics.market_indices
    DROP CONSTRAINT IF EXISTS market_indices_geography_id_fkey;

COMMENT ON TABLE analytics.sale_facts IS
    'One quality-controlled analytical row per sale transaction. Rebuilt as a whole by refresh_sale_facts inside the release transaction; deliberately no foreign key to the source tables or boundaries, so that source imports never change published facts.';
COMMENT ON TABLE analytics.rental_facts IS
    'One normalized monthly-rent fact per GURS rental agreement. Rebuilt as a whole by refresh_rental_facts inside the release transaction; deliberately no foreign key to the source tables or boundaries, so that source imports never change published facts.';
