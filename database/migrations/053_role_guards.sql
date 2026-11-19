-- Server-side guards for the read-only API role, as a fallback for the limits the API
-- sets on every connection (the connection-level SET still wins when present):
-- no statement may run longer than 15 s and no transaction may sit idle longer than 30 s.
ALTER ROLE real_estate_api SET statement_timeout = '15s';
ALTER ROLE real_estate_api SET idle_in_transaction_session_timeout = '30s';

-- Only the three application roles may connect to the database and only the
-- superuser and the pipeline may create temporary tables (the refresh functions and
-- reset-and-repopulate use them). PostgreSQL grants CONNECT and TEMPORARY to PUBLIC
-- by default; 013 and 045 granted the roles' own privileges but never revoked PUBLIC's.
DO $$
BEGIN
    EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO real_estate_api', current_database());
    EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO real_estate_pipeline', current_database());
END;
$$;
