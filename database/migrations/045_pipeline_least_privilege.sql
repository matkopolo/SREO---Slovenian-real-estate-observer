-- The pipeline worker downloads and parses external archives (GURS, SURS, BSI, ECB),
-- so it connects as the least-privilege real_estate_pipeline role, not the superuser.
-- It needs DML on the source and analytics tables and EXECUTE on the refresh
-- functions; it never needs DDL. Its LOGIN password and the SECURITY DEFINER setting
-- of the refresh functions are reconciled on every migration run (database/roles.sql).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'real_estate_pipeline') THEN
        CREATE ROLE real_estate_pipeline NOLOGIN;
    END IF;
END;
$$;

ALTER ROLE real_estate_pipeline NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA analytics FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE real_estate TO real_estate_pipeline;
GRANT USAGE ON SCHEMA public, analytics TO real_estate_pipeline;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public, analytics
    TO real_estate_pipeline;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, analytics TO real_estate_pipeline;
-- The migration ledger belongs to the runner only.
REVOKE ALL ON public.schema_migrations FROM real_estate_pipeline;

-- Tables and sequences that later migrations create (as real_estate) get the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE real_estate IN SCHEMA public, analytics
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO real_estate_pipeline;
ALTER DEFAULT PRIVILEGES FOR ROLE real_estate IN SCHEMA public, analytics
    GRANT USAGE, SELECT ON SEQUENCES TO real_estate_pipeline;
