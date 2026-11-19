-- Repeatable role reconciliation, run by run-migrations.sh after every migration run.
-- Must stay idempotent.
--
-- Passwords come from psql variables the runner sets only when the corresponding
-- environment variable is set (PIPELINE_DATABASE_PASSWORD, API_DATABASE_PASSWORD; Compose
-- always sets both, with development defaults). An unset variable leaves that role's
-- password unchanged, so a manual run outside Compose can never reset a production
-- password to a default.
ALTER ROLE real_estate_pipeline LOGIN;
\if :reconcile_pipeline_password
ALTER ROLE real_estate_pipeline PASSWORD :'pipeline_password';
\else
\echo Notice: PIPELINE_DATABASE_PASSWORD is not set; the real_estate_pipeline password is unchanged.
\endif

ALTER ROLE real_estate_api LOGIN;
\if :reconcile_api_password
ALTER ROLE real_estate_api PASSWORD :'api_password';
\else
\echo Notice: API_DATABASE_PASSWORD is not set; the real_estate_api password is unchanged.
\endif

-- PostgreSQL 16 ANALYZE requires table ownership, so the refresh entry points run with
-- their owner's (the migration role's) privileges. CREATE OR REPLACE FUNCTION resets
-- SECURITY DEFINER, which is why this is re-applied on every run rather than once.
-- A pinned search_path stops untrusted schemas (including pg_temp) from shadowing
-- their sources, and only the pipeline role may call them. ALTER FUNCTION ... SET
-- changes only the named setting; the work_mem the functions carry (052) is kept.
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
