-- migrate: no-transaction
-- Index builds run CONCURRENTLY so API reads of the fact tables are never blocked.
-- Every statement is idempotent. A failed CONCURRENTLY build leaves an INVALID index
-- that IF NOT EXISTS would keep forever, so each index is dropped first when invalid
-- (this also repairs near_duplicate_candidates_candidate_idx from 048, which had no guard).
DO $$
DECLARE
    name text;
BEGIN
    FOREACH name IN ARRAY ARRAY[
        'repeat_sale_pairs_previous_transaction_idx',
        'rental_facts_city_district_date_idx',
        'rental_facts_local_community_date_idx',
        'rental_facts_settlement_date_idx',
        'near_duplicate_candidates_candidate_idx'
    ]
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'analytics' AND c.relname = name AND NOT i.indisvalid
        ) THEN
            EXECUTE format('DROP INDEX analytics.%I', name);
            RAISE NOTICE 'dropped invalid index analytics.%', name;
        END IF;
    END LOOP;
END;
$$;

-- repeat_sale_pairs(previous_transaction_id) cascades from sale_facts (023). Without an
-- index, every row deleted from sale_facts ran one sequential scan of the pairs table:
-- 1.2 million scans and 17.7 billion tuples read over two refreshes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS repeat_sale_pairs_previous_transaction_idx
    ON analytics.repeat_sale_pairs (previous_transaction_id);

-- sale_facts has a (geography, contract_date) index for every level; rental_facts had
-- them only for municipality and statistical region.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rental_facts_city_district_date_idx
    ON analytics.rental_facts (city_district_id, contract_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS rental_facts_local_community_date_idx
    ON analytics.rental_facts (local_community_id, contract_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS rental_facts_settlement_date_idx
    ON analytics.rental_facts (settlement_id, contract_date);

-- Same definition as 048; only rebuilt here when the guard above dropped an invalid copy.
CREATE INDEX CONCURRENTLY IF NOT EXISTS near_duplicate_candidates_candidate_idx
    ON analytics.near_duplicate_candidates (transaction_kind, candidate_transaction_id);
