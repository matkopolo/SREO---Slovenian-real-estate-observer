-- Role-privilege assertions for a migrated database (013, 044, 045, 053, roles.sql).
-- Run by CI after the migrations and by hand:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/checks/privileges.sql
-- Catalog-based, so no login as the application roles is needed.
\set ON_ERROR_STOP on

DO $$
DECLARE
    offenders text;
    acl aclitem[];
BEGIN
    -- Both application roles exist and have no superuser or role/database creation rights.
    SELECT string_agg(rolname, ', ')
    INTO offenders
    FROM pg_roles
    WHERE rolname IN ('real_estate_api', 'real_estate_pipeline')
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'application roles with elevated attributes: %', offenders;
    END IF;
    IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('real_estate_api', 'real_estate_pipeline')) <> 2 THEN
        RAISE EXCEPTION 'real_estate_api and real_estate_pipeline must both exist';
    END IF;

    -- The API role is read-only: no write privilege on any table, no EXECUTE on the
    -- refresh functions, and read-only transactions by default.
    SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO offenders
    FROM pg_tables
    WHERE schemaname IN ('public', 'analytics')
      AND has_table_privilege('real_estate_api', format('%I.%I', schemaname, tablename),
                              'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'real_estate_api can write: %', offenders;
    END IF;
    SELECT string_agg(p.proname, ', ')
    INTO offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'analytics'
      AND p.proname LIKE 'refresh\_%'
      AND has_function_privilege('real_estate_api', p.oid, 'EXECUTE');
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'real_estate_api can execute refresh functions: %', offenders;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'real_estate_api'
          AND 'default_transaction_read_only=on' = ANY (rolconfig)
    ) THEN
        RAISE EXCEPTION 'real_estate_api must default to read-only transactions';
    END IF;

    -- Neither role can create objects (no DDL): no CREATE on either schema.
    SELECT string_agg(r.rolname || ' on ' || s.nspname, ', ')
    INTO offenders
    FROM pg_roles r
    CROSS JOIN pg_namespace s
    WHERE r.rolname IN ('real_estate_api', 'real_estate_pipeline')
      AND s.nspname IN ('public', 'analytics')
      AND has_schema_privilege(r.rolname, s.nspname, 'CREATE');
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'application roles may not create objects: %', offenders;
    END IF;

    -- The migration ledger belongs to the runner only.
    IF has_table_privilege('real_estate_pipeline', 'public.schema_migrations',
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
        RAISE EXCEPTION 'real_estate_pipeline must not access public.schema_migrations';
    END IF;

    -- The pipeline can refresh: EXECUTE on every refresh function, DML on the fact tables.
    SELECT string_agg(p.proname, ', ')
    INTO offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'analytics'
      AND p.proname LIKE 'refresh\_%'
      AND NOT (p.prosecdef AND has_function_privilege('real_estate_pipeline', p.oid, 'EXECUTE'));
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'refresh functions not SECURITY DEFINER or not executable by the pipeline: %', offenders;
    END IF;
    IF NOT has_table_privilege('real_estate_pipeline', 'analytics.sale_facts', 'INSERT, UPDATE, DELETE') THEN
        RAISE EXCEPTION 'real_estate_pipeline needs DML on analytics tables';
    END IF;

    -- PUBLIC may neither connect to nor create temporary tables in the database (053).
    -- A NULL datacl means the PostgreSQL default, which grants both to PUBLIC.
    SELECT datacl INTO acl FROM pg_database WHERE datname = current_database();
    IF acl IS NULL OR EXISTS (
        SELECT 1 FROM aclexplode(acl) e
        WHERE e.grantee = 0 AND e.privilege_type IN ('CONNECT', 'TEMPORARY')
    ) THEN
        RAISE EXCEPTION 'PUBLIC still holds CONNECT or TEMPORARY on database %', current_database();
    END IF;
    IF NOT has_database_privilege('real_estate_api', current_database(), 'CONNECT')
       OR NOT has_database_privilege('real_estate_pipeline', current_database(), 'CONNECT, TEMPORARY') THEN
        RAISE EXCEPTION 'application roles lost their database privileges';
    END IF;

    RAISE NOTICE 'privilege checks passed';
END;
$$;
