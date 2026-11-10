#!/usr/bin/env bash
# Applies database/migrations/026+ to the Compose database, then reconciles roles.
#
# Everything runs in one psql session that holds an advisory lock, so two runners
# (for example `make db-migrate` while the stack starts) never interleave.
# Each migration and its schema_migrations row commit in one transaction: a failing
# migration leaves nothing applied and nothing recorded. A migration whose first line
# is `-- migrate: no-transaction` (needed for CREATE INDEX CONCURRENTLY) runs outside
# a transaction and must be idempotent.
set -euo pipefail

# Compose default; CI points DATABASE_URL at its service container.
database_url="${DATABASE_URL:-postgresql://real_estate:real_estate@db:5432/real_estate}"
migrations_dir="${MIGRATIONS_DIR:-/migrations}"
roles_file="${ROLES_FILE:-/roles.sql}"
pipeline_password="${PIPELINE_DATABASE_PASSWORD:-real_estate_pipeline}"
lock_id=724202607

until pg_isready -d "$database_url" >/dev/null 2>&1; do
  sleep 1
done

build_script() {
  cat <<SQL
SELECT pg_advisory_lock($lock_id) AS locked \\gset
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
\\warn WARNING: $filename changed after it was applied; write a new migration instead.
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

build_script | psql -X -q -v ON_ERROR_STOP=1 -v pipeline_password="$pipeline_password" "$database_url"
