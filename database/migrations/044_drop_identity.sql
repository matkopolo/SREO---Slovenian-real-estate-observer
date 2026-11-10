-- The API is read-only again: accounts, sessions, saved preferences and anomaly-review writes
-- were removed (no client used them, and any registered account could rewrite published
-- review notes). Migration 017 stays as history; this one undoes its grants and tables.
-- Anomaly review columns stay in analytics.anomaly_signals; only the API's write access goes.

REVOKE UPDATE (review_status, review_notes, reviewed_by, reviewed_at)
    ON analytics.anomaly_signals FROM real_estate_api;

DO $$
DECLARE
    identity_table text;
BEGIN
    FOREACH identity_table IN ARRAY ARRAY['public.user_preferences', 'public.auth_sessions', 'public.app_users']
    LOOP
        IF to_regclass(identity_table) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON %s FROM real_estate_api', identity_table);
        END IF;
    END LOOP;
END;
$$;

DROP TABLE IF EXISTS public.user_preferences;
DROP TABLE IF EXISTS public.auth_sessions;
DROP TABLE IF EXISTS public.app_users;

ALTER ROLE real_estate_api SET default_transaction_read_only = on;
