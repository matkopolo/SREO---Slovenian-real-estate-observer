-- migrate: no-transaction
-- The current-market estimate excludes near-duplicate candidates by candidate_transaction_id;
-- without an index starting with that column each lookup scanned the table. Built without blocking reads.
CREATE INDEX CONCURRENTLY IF NOT EXISTS near_duplicate_candidates_candidate_idx
    ON analytics.near_duplicate_candidates (transaction_kind, candidate_transaction_id);
