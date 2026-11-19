# Pinned so a rebuild never upgrades the database engine or PostGIS by surprise.
# To upgrade: bump both versions together, rebuild, and run the migrations; the
# PGDG repository drops old package versions over time, so a stale pin fails the
# build loudly instead of silently installing something newer.
# postgres:16.15-bookworm, pinned to its manifest-list digest (Dependabot keeps it current).
ARG POSTGRES_IMAGE=postgres:16.15-bookworm@sha256:5264710be20f409750ac6dc4e5706dcef929c87e241605463f0f9aefa932a8d9
FROM ${POSTGRES_IMAGE}

ARG POSTGIS_VERSION=3.7.0+dfsg-1.pgdg12+1
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        "postgresql-16-postgis-3=${POSTGIS_VERSION}" \
        "postgresql-16-postgis-3-scripts=${POSTGIS_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY database/migrations/ /docker-entrypoint-initdb.d/
# A new volume installs only the 001-025 baseline. 026+ are applied and recorded
# by the database-migrations service (run-migrations.sh); installing them here
# too would make it re-run non-idempotent migrations such as 038.
RUN find /docker-entrypoint-initdb.d -name '*.sql' \
        ! -name '00[0-9]_*' ! -name '01[0-9]_*' ! -name '02[0-5]_*' -delete \
    && chmod 644 /docker-entrypoint-initdb.d/*.sql
