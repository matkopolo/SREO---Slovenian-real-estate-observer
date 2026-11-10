-- migrate: no-transaction
-- Runs outside a transaction so the index changes are CONCURRENTLY and never block
-- API reads of sale_facts or cadastre_buildings. Every statement is idempotent.

-- Created and seeded by 022 but never read by any function, API or pipeline code.
DROP TABLE IF EXISTS analytics.publication_policy;

-- No query filters sale_facts by dataset_year (idx_scan = 0); source-table imports use
-- transactions_municipality_year_idx and rental_transactions_year_idx instead.
DROP INDEX CONCURRENTLY IF EXISTS analytics.sale_facts_dataset_year_idx;

-- The construction summary and the pipeline's snapshot check both run
-- max(source_date) over ~1.2 M buildings; without an index that is a full scan.
-- A failed CONCURRENTLY build leaves an invalid index that IF NOT EXISTS would keep.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'analytics' AND c.relname = 'cadastre_buildings_source_date_idx'
          AND NOT i.indisvalid
    ) THEN
        DROP INDEX analytics.cadastre_buildings_source_date_idx;
    END IF;
END;
$$;
CREATE INDEX CONCURRENTLY IF NOT EXISTS cadastre_buildings_source_date_idx
    ON analytics.cadastre_buildings (source_date);
