# Database architecture

## Land browsing categories

Migration `037_land_browsing_categories.sql` adds an immutable classification
function `analytics.land_market_category(integer[],integer)` and the read-only
`analytics.land_market_categories` view over published `land_transaction_facts`.
Five sale-fact views expose agricultural, forest, unverified building land, mixed
and other/unknown populations. Existing strict/broad/all views are unchanged.
All category views retain non-land rows for compatibility; `propertyGroup=land`
selects the land population. A land sale lacking any land-fact classification
belongs to the other/unknown view. API access is SELECT-only.

No backfill, analytical refresh or model retraining is required: categories are
derived from the existing distinct ETN codes and unknown-parcel count at query
time. Published analytical releases therefore remain the source of truth.

Docker Compose is the only runtime and owns the database lifecycle. SQL files are
bundled into the PostGIS image for first-volume initialization and into the
migration client image for subsequent upgrades. Named volumes retain data. The API
and the pipeline use separate least-privilege roles and never perform migrations.

## Purpose and ownership

PostgreSQL 16 with PostGIS is the system of record. It stores structured GURS
source rows, current GURS RPE geography, deterministic analytical facts,
offline-model outputs and official context series (SURS, Banka Slovenije, ECB).
Neither the API nor the frontend maintains a second copy of market data.

Schema changes are ordered SQL files in `database/migrations`. A new volume
installs the 001-025 baseline; the `database-migrations` service applies and
records 026+ (see [Migrations](#migrations)).

## Logical schemas

### `public`: source fidelity

- `source_files` is the import/provenance ledger (scope, product, year,
  checksum, and timestamps).
- `transactions`, `building_parts`, and `land_parcels` preserve BUY/KPP
  agreement and component rows.
- `rental_transactions` and `rental_building_parts` preserve RENT/NP rows.
- `codebook_values` and `codebook_imports` preserve GURS categorical meaning.
- `municipalities` and `cadastral_municipalities` are source references.
- `schema_migrations` is the migration ledger.

Public ETN party names and identifiers are not present in the source archives
or schema. Unstructured GURS note fields are intentionally excluded from import
and removed by migration 027 because they are unnecessary for analytics and
could theoretically contain identifying free text. This is the sole deliberate
exception to structured source-field preservation. See
[`data-licensing-privacy.md`](data-licensing-privacy.md).

Source child rows use internal identities plus `(source_file_id,
source_row_number)` uniqueness because historical cadastral identifiers may be
missing. Negative GURS transaction identifiers are valid. Empty values remain
null; analytical code never invents missing prices, rents, areas, or locations.

### `analytics`: query-ready and derived data

- `geographic_units` stores the country-to-settlement hierarchy and PostGIS
  polygons in EPSG:3794 and EPSG:4326.
- `sale_facts` and `rental_facts` contain one row per agreement, preventing a
  house, garage, and parcel package from being counted as three transactions.
- `land_transaction_facts` and the strict/broad/all views encode explicit land
  populations.
- outlier evaluations, anomaly signals, near-duplicate candidates, and
  missingness profiles retain explainable quality evidence.
- `sale_package_signature` and `rental_package_signature` derive deterministic
  multisets of ETN component-type codes for exact comparable-package matching;
  they do not replace or modify the raw component rows.
- model runs, valuation predictions, index calculation runs, market indices,
  and repeat-sale pairs retain versioned analytical outputs.
- `refresh_runs` records deterministic refresh status and diagnostics.
- `cadastre_buildings` and `cadastre_codebooks` hold the GURS building cadastre
  snapshot (construction views); `context_series` and `lending_rules` hold SURS,
  Banka Slovenije and ECB context (affordability, demography, permits). See the
  [data dictionary](../database/documentation/data-dictionary.md).

### Atomic analytical publication

`analytical_releases` records source cutoffs, published analytical cutoffs,
model versions, processing stages, and outcomes. `analytical_publication` is a
singleton pointer to the active release and any pending replacement. Raw GURS
imports commit first; facts, outlier classifications, shared analytics,
indices, model predictions, and the release pointer then change inside one
PostgreSQL transaction. API readers therefore retain the previous committed
generation until all required work succeeds.

Predictions are immutable per model run. `model_publications` selects the
active sale and rental generations and `current_valuation_predictions` is the
API-facing view. Pending or failed training never overwrites active model
predictions.

Repeat-sale pairs are fully derived. Both links to `sale_facts` cascade on
deletion so replacing a yearly GURS archive safely invalidates obsolete pairs;
the analytics refresh recreates them after the fact tables are current.

## Spatial model

Source centroids are D96/TM coordinates (EPSG:3794). Generated `location`
columns create PostGIS points only when both coordinates exist and have GiST
indexes. Fact refreshes aggregate component points to one representative
transaction centroid. One settlement spatial lookup supplies settlement,
municipality, and statistical-region ancestry; city districts and local
communities remain independent spatial lookups because they are sibling RPE
levels whose polygons do not always nest perfectly. WGS84 transformations are
performed for browser maps.

These are source centroids, not guaranteed entrances. Current polygons do not
reconstruct historical administrative boundaries. Missing locations remain
observable in coverage metrics but cannot appear on a point map.

## Data lifecycle

```text
GURS ZIP/CSV
  -> source_files + public source tables
  -> current RPE geographic_units
  -> transaction-grain facts and quality evaluations
  -> anomaly/missingness/duplicate tables and matched-pair indices
  -> offline models, predictions, Isolation Forest scores, hedonic indices
  -> read-only API queries
```

The worker takes a PostgreSQL advisory lock, imports each archive
transactionally, then refreshes derived objects in dependency order. A failed
step does not expose a partially imported archive. The normal scheduled run is
every 14 days and also rechecks the current year for revisions. A new database
trains its initial valuation models once. After that bootstrap, training is
available only through the explicit `make models-refresh` command.

`make reset-and-repopulate` truncates market-source and derived analytical
tables with explicit confirmation, then rebuilds them. It runs as the
development superuser, because `TRUNCATE … RESTART IDENTITY` needs table
ownership. Valuation runs and predictions are removed and are
not automatically recreated because the durable installation bootstrap marker
is preserved. Docker volumes survive normal container rebuilds;
deleting the database volume also deletes persisted model output, which can be
recovered only from a database backup or by explicit model retraining.

The local PostgreSQL container is tuned within its 4GB limit for full-table
analytical rebuilds. Independent sale and rental chains run concurrently on two
connections; shared anomaly, duplicate, missingness, and repeat-index stages run
only after both chains succeed. Each chain is transactional, but the complete
cross-chain refresh is not one transaction, so readers can briefly observe mixed
generations during a scheduled rebuild. Fact-table refresh functions delete and
repopulate their tables in a transaction (migration 040 replaced TRUNCATE), so API
reads keep seeing the previous committed rows instead of waiting on locks. The worker prints a periodic heartbeat for long SQL stages, followed
by the exact row count and duration. Individual `analytics.refresh_runs` stages
also use wall-clock start timestamps.

## Access and integrity

Migrations 038/039 add `analytics.property_history_events` and
`analytics.property_resale_pairs` views plus three source identity/reference
indexes. They reuse published sale facts and current source components; no
ETN records, valuations, outlier flags or index populations are modified.
History totals come from reported `transactions.contract_price`, not derived
fact prices. See [property-history definitions](property-history.md) for exact
identity matching, share/package safeguards and publication rules.

Foreign keys connect agreements, source files, and components. Check
constraints encode enumerations and valid review states. B-tree indexes serve
dates, property groups, geographic identifiers, and cadastral building keys;
GiST serves spatial filtering; GIN serves anomaly flags.

Three roles (details in the [data dictionary](../database/documentation/data-dictionary.md#database-roles)):

- `real_estate`, the development superuser, owns every object. Only the migration
  runner and destructive admin commands (`make reset-and-repopulate`) use it.
- `real_estate_pipeline` is what the worker connects as (migration 045). It has
  DML on `public` and `analytics` tables and EXECUTE on `analytics.refresh_*`, and
  no DDL. Refresh functions run as SECURITY DEFINER with a pinned `search_path`,
  because PostgreSQL 16 `ANALYZE` needs table ownership. `database/roles.sql`
  re-applies that and the role's password on every migration run, because
  `CREATE OR REPLACE FUNCTION` resets SECURITY DEFINER. New tables get the
  pipeline grants through default privileges.
- `real_estate_api` only reads published data. It cannot import, migrate or
  refresh anything.

Postgres is published on `127.0.0.1:5432` only.

## Operations

```bash
make db-up                 # start PostGIS and apply migrations
make db-migrate            # reapply incremental migrations
make analytics-refresh     # deterministic database-derived objects
make models-refresh        # explicit retraining after first-install bootstrap
make reset-and-repopulate  # destructive market-data rebuild (runs as superuser)
```

Default local connection: `postgresql://real_estate:real_estate@localhost:5432/real_estate`.
The complete source-column reference remains in
`database/documentation/data-dictionary.md`; statistical population and
quality definitions are in `docs/statistical-methodology.md`.

## Local database operations

```bash
make db-up
```

The default superuser connection from the host is `postgresql://real_estate:real_estate@localhost:5432/real_estate` (loopback only). `.env` (from `.env.example`) sets Compose variables such as `PIPELINE_DATABASE_PASSWORD`; the superuser credentials are fixed development values.

The database image is built from the official multi-architecture PostgreSQL 16 image with its matching PostGIS package, so it runs natively on Intel/AMD64 and Apple Silicon/ARM64 machines. On a full `docker compose up`, the one-shot `database-migrations` service waits for first-volume initialization to finish, applies unapplied incremental migrations, records them in `public.schema_migrations`, and exits before `pipeline-worker`, `real-estate-api` and `observer` start. This also upgrades preserved database volumes; PostgreSQL's image-bundled `/docker-entrypoint-initdb.d` scripts run automatically only when a volume is first created. Schema/script files are copied into images, not bind-mounted from the host. `make db-up` performs the equivalent migration step explicitly. The named Docker volume is preserved when the container image changes, so existing imported data does not need to be downloaded again.

The `building_parts`, `land_parcels`, and `rental_building_parts` tables expose a generated `location geometry(Point,3794)` column backed by a GiST spatial index. It is automatically derived from the original `centroid_e` and `centroid_n` values; the importer does not need to populate it.

To apply only the spatial migration to an already-running PostGIS container:

```bash
make db-migrate
```

Return longitude and latitude for a web map with:

```sql
SELECT
    id,
    ST_X(ST_Transform(location, 4326)) AS longitude,
    ST_Y(ST_Transform(location, 4326)) AS latitude
FROM building_parts
WHERE location IS NOT NULL;
```

The point is the source property's centroid, not necessarily an entrance or postal-address coordinate. A transaction can also reference multiple property rows and therefore multiple map points.

### Development memory budget

PostgreSQL/PostGIS remains the source of truth and analytical engine; the
dataset is never copied wholesale into Go memory. Docker Compose applies
development ceilings of 4 GB for PostgreSQL, 3 GB for the offline pipeline
worker, 512 MB for the Go API, and 128 MB for the nginx-served frontend. These are
maximums, not reserved memory.

Within the 4 GB database ceiling, Compose configures PostgreSQL with 1 GB
`shared_buffers`, 64 MB per-node `work_mem`, 512 MB
`maintenance_work_mem`, a 3 GB effective cache estimate, and up to four
parallel workers per gather. The container has 1 GB of shared memory for parallel
PostgreSQL operations; this is included in, not added to, its memory ceiling. These settings target the periodic offline
analytics rebuild; PostgreSQL/PostGIS still owns all durable data.

Allocate 8–12 GB to Docker Desktop for a full model refresh alongside
PostgreSQL and image builds. The API uses bounded SQL queries, pagination, map
bounding boxes, and precomputed database aggregates.

## Migrations

`database/run-migrations.sh` (the `database-migrations` image) is the only
migration runner. Docker Compose is the only supported runtime, so the earlier
production runner (`production_migrate.py`, `production-migrations/`, its tests and
image) was removed: it kept a second ledger and a one-shot privileges file that
later migrations silently undid.

- **Baseline.** 001-025 are installed by the database image on a new volume
  (`/docker-entrypoint-initdb.d`) and are not recorded. Runtime tracking starts
  at 026.
- **Gap.** 030-035 never existed. Do not fill the gap: always add the next number
  after the highest existing file.
- **One session, one lock.** The runner sends one psql script that takes
  `pg_advisory_lock(724202607)`, so two runs (for example `make db-migrate` while
  the stack starts) never interleave.
- **Atomic.** Each migration runs in its own transaction together with its
  `schema_migrations` row: a failing migration leaves nothing applied and nothing
  recorded. Do not write `BEGIN`/`COMMIT` in migration files.
- **Outside a transaction.** A file whose first line is
  `-- migrate: no-transaction` runs without the wrapper. Use it only for
  `CREATE/DROP INDEX CONCURRENTLY` on large tables (so API reads are never
  blocked), and make every statement idempotent (`IF [NOT] EXISTS`), because a
  failure can leave it partly applied. See 046.
- **Checksums.** The ledger stores each file's SHA-256. The runner warns when an
  applied file has changed; write a new migration instead of editing one.
- **Roles.** After the migrations, `database/roles.sql` reconciles the pipeline
  login password (`PIPELINE_DATABASE_PASSWORD`) and refresh-function security.
  It must stay idempotent.

Run it with `make db-migrate` (`docker compose run --rm database-migrations`).
CI applies every file with plain `psql -f` to a fresh database, and the Compose
smoke test runs the real runner twice on a fresh volume.

### Dropped objects and index review

Migration 046 dropped `analytics.publication_policy` (never read) and
`sale_facts_dataset_year_idx` (no query filters `sale_facts` by `dataset_year`),
and added `cadastre_buildings_source_date_idx` for `max(source_date)`. The
indexes below had zero scans after a refresh and QA cycle but are kept, because
a query path or an import uses them, or the evidence is too short:
`valuation_predictions_lookup_idx` (prediction lookups by transaction),
`land_parcels_location_gist_idx` and `land_parcels_location_idx` (spatial and
municipality parcel lookups), `cadastre_buildings_identity_idx` (building lookup by
cadastral code and number), `anomaly_signals_flags_gin_idx` (`flags @>` filter in
the anomaly list), and the `(source_file_id, source_row_number)` unique keys
(import integrity). Re-check `pg_stat_user_indexes` after a few more refreshes
before dropping any of them.
