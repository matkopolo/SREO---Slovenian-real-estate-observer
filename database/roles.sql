-- Repeatable role reconciliation, run by run-migrations.sh after every migration run
-- with psql variable pipeline_password (PIPELINE_DATABASE_PASSWORD in Compose).
-- Must stay idempotent.
ALTER ROLE real_estate_pipeline LOGIN PASSWORD :'pipeline_password';

-- PostgreSQL 16 ANALYZE requires table ownership, so the refresh entry points run with
-- their owner's (the migration role's) privileges. CREATE OR REPLACE FUNCTION resets
-- SECURITY DEFINER, which is why this is re-applied on every run rather than once.
-- A pinned search_path stops untrusted schemas (including pg_temp) from shadowing
-- their sources, and only the pipeline role may call them.
DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'analytics' AND p.proname LIKE 'refresh\_%'
    LOOP
        EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', f.signature);
        EXECUTE format(
            'ALTER FUNCTION %s SET search_path = pg_catalog, public, analytics, pg_temp',
            f.signature);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.signature);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO real_estate_pipeline', f.signature);
    END LOOP;
END;
$$;
