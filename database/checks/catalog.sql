-- Catalog assertions for a migrated database. Run by CI after the migrations and by hand:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/checks/catalog.sql
-- Each assertion raises, so the exit code is non-zero on the first failure.
\set ON_ERROR_STOP on

DO $$
DECLARE
    offenders text;
BEGIN
    -- 1. No INVALID index (a failed CREATE INDEX CONCURRENTLY leaves one behind; the
    --    planner ignores it while every write still maintains it).
    SELECT string_agg(indexrelid::regclass::text, ', ')
    INTO offenders
    FROM pg_index
    WHERE NOT indisvalid;
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'invalid indexes: %', offenders;
    END IF;

    -- 2. Every foreign key whose delete action does work on the referencing table
    --    (CASCADE, SET NULL, SET DEFAULT) has a valid, unconditional index whose leading
    --    column is the referencing column. Without it each deleted referenced row runs a
    --    sequential scan of the referencing table (migration 051 explains the cost).
    SELECT string_agg(format('%s(%s) -> %s', c.conrelid::regclass, a.attname, c.confrelid::regclass), ', ')
    INTO offenders
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confdeltype IN ('c', 'n', 'd')
      AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND i.indkey[0] = a.attnum
            AND i.indisvalid
            AND i.indpred IS NULL
      );
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'cascading foreign keys without a leading index: %', offenders;
    END IF;

    -- 3. No analytics function truncates: TRUNCATE takes ACCESS EXCLUSIVE until the
    --    release transaction commits and blocks every API read (040, 052).
    SELECT string_agg(n.nspname || '.' || p.proname, ', ')
    INTO offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'analytics'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ~* '\mTRUNCATE\M';
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'analytics functions containing TRUNCATE: %', offenders;
    END IF;

    -- 4. The fact tables have no foreign key to the source tables or to boundaries, so
    --    that a committed source import or boundary sync cannot change published facts
    --    (050; the release transaction rebuilds the facts as a whole).
    SELECT string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ')
    INTO offenders
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid IN ('analytics.sale_facts'::regclass, 'analytics.rental_facts'::regclass);
    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION 'fact tables must not carry foreign keys (050): %', offenders;
    END IF;

    RAISE NOTICE 'catalog checks passed';
END;
$$;
