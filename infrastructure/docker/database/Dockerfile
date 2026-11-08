FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends postgresql-16-postgis-3 \
    && rm -rf /var/lib/apt/lists/*

COPY database/migrations/ /docker-entrypoint-initdb.d/
# A new volume installs only the 001-025 baseline. 026+ are applied and recorded
# by the database-migrations service (run-migrations.sh); installing them here
# too would make it re-run non-idempotent migrations such as 038.
RUN find /docker-entrypoint-initdb.d -name '*.sql' \
        ! -name '00[0-9]_*' ! -name '01[0-9]_*' ! -name '02[0-5]_*' -delete \
    && chmod 644 /docker-entrypoint-initdb.d/*.sql
