FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends postgresql-16-postgis-3 \
    && rm -rf /var/lib/apt/lists/*

COPY database/migrations/ /docker-entrypoint-initdb.d/
RUN chmod 644 /docker-entrypoint-initdb.d/*.sql
