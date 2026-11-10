-- Analytics refresh functions emptied their tables with TRUNCATE. TRUNCATE takes an
-- ACCESS EXCLUSIVE lock that is held until the whole refresh transaction commits
-- (including model training, ~40 minutes), so every API read of sale/rental facts
-- blocked and the dashboard stopped loading for the duration of each refresh.
--
-- DELETE keeps the previous committed rows visible to concurrent readers (MVCC) until
-- the refresh commits, which is what atomic publication (036) promises. Every table
-- that references sale_facts/rental_facts has ON DELETE CASCADE, so DELETE removes the
-- same rows TRUNCATE ... CASCADE did.
--
-- Rewrite only the TRUNCATE statements inside the current function definitions; the
-- rest of each function body is kept exactly as previously migrated.
DO $$
DECLARE
    fn record;
    definition text;
    rewritten text;
BEGIN
    FOR fn IN
        SELECT p.oid, p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'analytics'
          AND p.proname LIKE 'refresh\_%'
          AND pg_get_functiondef(p.oid) ~ 'TRUNCATE'
    LOOP
        definition := pg_get_functiondef(fn.oid);
        rewritten := regexp_replace(
            definition,
            'TRUNCATE\s+(analytics\.[a-z_]+)(\s+CASCADE)?\s*;',
            'DELETE FROM \1;',
            'g'
        );
        IF rewritten ~ 'TRUNCATE' THEN
            RAISE EXCEPTION 'analytics.% still contains TRUNCATE after rewrite', fn.proname;
        END IF;
        EXECUTE rewritten;
        RAISE NOTICE 'analytics.%: TRUNCATE replaced by DELETE', fn.proname;
    END LOOP;
END;
$$;
