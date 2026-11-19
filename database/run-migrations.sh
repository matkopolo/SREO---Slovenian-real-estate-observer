#!/usr/bin/env bash
# Applies database/migrations/026+ to the Compose database, then reconciles roles.
#
# Everything runs in one psql session that holds an advisory lock, so two runners
# (for example `make db-migrate` while the stack starts) never interleave. The pipeline
# worker holds the same lock for the whole of a system refresh, so the runner first waits
# for it with a message and a bounded poll (MIGRATIONS_LOCK_WAIT_SECONDS, default one hour)
# instead of blocking silently.
# Each migration and its schema_migrations row commit in one transaction: a failing
# migration leaves nothing applied and nothing recorded. A migration whose first line
# is `-- migrate: no-transaction` (needed for CREATE INDEX CONCURRENTLY) runs outside
# a transaction and must be idempotent. After the migrations the runner fails when any
# index is left INVALID (a failed CONCURRENTLY build).
# The ledger stores each file's SHA-256; an applied file whose checksum changed stops the
# run unless MIGRATIONS_ALLOW_CHANGED=1, which accepts the new checksum with a warning.
# Role passwords are reconciled only from variables that are set: PIPELINE_DATABASE_PASSWORD
# and API_DATABASE_PASSWORD (Compose always sets both, with development defaults); an unset
# variable leaves that role's password unchanged and prints a notice.
set -euo pipefail

# Compose default; CI points DATABASE_URL at its service container.
database_url="${DATABASE_URL:-postgresql://real_estate:real_estate@db:5432/real_estate}"
migrations_dir="${MIGRATIONS_DIR:-/migrations}"
roles_file="${ROLES_FILE:-/roles.sql}"
lock_wait_seconds="${MIGRATIONS_LOCK_WAIT_SECONDS:-3600}"
allow_changed="${MIGRATIONS_ALLOW_CHANGED:-0}"
lock_id=724202607

until pg_isready -d "$database_url" >/dev/null 2>&1; do
  sleep 1
done

# The pipeline takes the lock with pg_try_advisory_lock and the runner must never
# interleave with a refresh, so poll until the lock is free (or the deadline passes).
# The lock itself is taken by the migration session below, with a short lock_timeout
# in case a refresh starts between the poll and that statement.
wait_for_maintenance_lock() {
  local started=$SECONDS free holder reported=0
  while true; do
    free="$(psql -X -At -v ON_ERROR_STOP=1 "$database_url" -c \
      "SELECT CASE WHEN pg_try_advisory_lock($lock_id) THEN pg_advisory_unlock($lock_id) ELSE false END")"
    if [[ "$free" == "t" ]]; then
      if (( reported )); then echo "Maintenance lock is free; continuing."; fi
      return 0
    fi
    if (( SECONDS - started >= lock_wait_seconds )); then
      echo "Gave up after ${lock_wait_seconds}s: the database maintenance lock is still held." >&2
      echo "Wait for the pipeline refresh to finish, or raise MIGRATIONS_LOCK_WAIT_SECONDS." >&2
      exit 1
    fi
    if (( reported == 0 || (SECONDS - started) % 60 == 0 )); then
      holder="$(psql -X -At "$database_url" -c \
        "SELECT string_agg(format('pid %s (%s, %s)', a.pid, coalesce(nullif(a.application_name,''),'no application_name'), a.usename), ', ')
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND l.classid = 0 AND l.objid = $lock_id AND l.granted" 2>/dev/null || true)"
      echo "Waiting for the database maintenance lock (held by ${holder:-another session}; a pipeline refresh holds it until it publishes); $((SECONDS - started))s elapsed."
      reported=1
    fi
    sleep 10
  done
}

build_script() {
  cat <<SQL
\\set ON_ERROR_STOP on
SET lock_timeout = '30s';
SELECT pg_advisory_lock($lock_id) AS locked \\gset
RESET lock_timeout;
SET client_min_messages = warning;
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version integer PRIMARY KEY,
    filename text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
COMMENT ON TABLE public.schema_migrations IS
    'Incremental database migrations applied after the supported schema baseline.';
RESET client_min_messages;
SQL

  local migration filename version checksum
  for migration in "$migrations_dir"/[0-9][0-9][0-9]_*.sql; do
    filename="${migration##*/}"
    if [[ ! "$filename" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
      echo "Unexpected migration file name: $filename" >&2
      exit 1
    fi
    version=$((10#${filename%%_*}))

    # Migrations 001-025 form the supported baseline and are installed by the
    # database image on a new volume. Runtime tracking starts with migration 026.
    if (( version < 26 )); then
      continue
    fi

    checksum="$(sha256sum "$migration" | cut -d' ' -f1)"
    cat <<SQL
SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version=$version) AS applied,
       COALESCE((SELECT checksum IS NOT NULL AND checksum <> '$checksum'
                 FROM public.schema_migrations WHERE version=$version), false) AS changed
\\gset
\\if :applied
\\echo Already applied $filename
\\if :changed
SQL
    if [[ "$allow_changed" == "1" ]]; then
      cat <<SQL
\\warn WARNING: $filename changed after it was applied; MIGRATIONS_ALLOW_CHANGED=1 accepts the new checksum.
UPDATE public.schema_migrations SET checksum='$checksum' WHERE version=$version;
SQL
    else
      cat <<SQL
DO \$\$ BEGIN
  RAISE EXCEPTION '$filename changed after it was applied; write a new migration instead (MIGRATIONS_ALLOW_CHANGED=1 accepts the change)';
END \$\$;
SQL
    fi
    cat <<SQL
\\endif
UPDATE public.schema_migrations SET checksum='$checksum' WHERE version=$version AND checksum IS NULL;
\\else
\\echo Applying $filename
SQL
    if head -n 1 "$migration" | grep -q '^-- migrate: no-transaction'; then
      cat <<SQL
\\i $migration
INSERT INTO public.schema_migrations(version,filename,checksum) VALUES($version,'$filename','$checksum');
SQL
    else
      cat <<SQL
BEGIN;
\\i $migration
INSERT INTO public.schema_migrations(version,filename,checksum) VALUES($version,'$filename','$checksum');
COMMIT;
SQL
    fi
    printf '%s\n' '\endif'
  done

  # A failed CONCURRENTLY build (or any other interrupted index build) leaves an
  # INVALID index that the planner ignores while writes keep maintaining it.
  cat <<SQL
\\echo Checking indexes
DO \$\$
DECLARE invalid text;
BEGIN
  SELECT string_agg(indexrelid::regclass::text, ', ') INTO invalid FROM pg_index WHERE NOT indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'invalid index left behind: % (drop it and rerun the migration that builds it)', invalid;
  END IF;
END \$\$;
SQL

  # Repeatable: role logins and refresh-function security, re-applied on every run
  # because CREATE OR REPLACE FUNCTION resets SECURITY DEFINER.
  cat <<SQL
\\echo Reconciling roles
BEGIN;
\\i $roles_file
COMMIT;
SELECT pg_advisory_unlock($lock_id) AS unlocked \\gset
SQL
}

wait_for_maintenance_lock

psql_args=(-X -q -v ON_ERROR_STOP=1)
if [[ -n "${PIPELINE_DATABASE_PASSWORD:-}" ]]; then
  psql_args+=(-v reconcile_pipeline_password=true -v "pipeline_password=$PIPELINE_DATABASE_PASSWORD")
else
  psql_args+=(-v reconcile_pipeline_password=false -v pipeline_password=)
fi
if [[ -n "${API_DATABASE_PASSWORD:-}" ]]; then
  psql_args+=(-v reconcile_api_password=true -v "api_password=$API_DATABASE_PASSWORD")
else
  psql_args+=(-v reconcile_api_password=false -v api_password=)
fi

build_script | psql "${psql_args[@]}" "$database_url"
