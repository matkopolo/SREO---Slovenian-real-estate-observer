# Data pipeline worker

Run the worker through Docker Compose; no local Python environment is required.
`MODEL_REFRESH_POLICY=manual` disables automatic model training during scheduled
refresh and initial import; use an explicit `docker compose run --rm pipeline-worker refresh-models` command. The default
`auto` preserves Compose's initial/new-archive training behavior.

Every command that writes to the database (imports, syncs, analytics, models,
refresh and reset, including the per-municipality diagnostics) takes the
scheduler's PostgreSQL advisory lock and fails fast with "already running"
instead of interleaving with another refresh. `fetch` and `fetch-national` only
download and need no database. Downloads go to `--output-dir`, which defaults to
`$RAW_DATA_DIR` or `/data/raw` (the `pipeline_data` volume in the image).

Detailed definitions for quality populations, robust cohort outliers,
duplicate signals, valuation-model selection, rolling temporal validation,
building/municipality robustness, split-conformal ranges, Isolation Forest,
and market indices are in
[../../docs/statistical-methodology.md](../../docs/statistical-methodology.md).

In particular, the methodology explains how many rows are eligible, how
training/calibration/validation years are formed, why models are national per
transaction kind and property group rather than per region, and where exact
per-run counts and selected parameters are persisted. Measured results from the
representative optimization run are in
[../../docs/model-optimization-report.md](../../docs/model-optimization-report.md).

The production-style pipeline runs inside Docker. The image contains Python
3.11, the GURS downloader/importer, psycopg, NumPy, SciPy, and scikit-learn.
Host Python is needed only for optional local development.

## Scheduled operation

Compose starts `pipeline-worker` with:

```text
real-estate-etl schedule --interval-days 14
```

It runs once immediately, then every 14 days; failures retry after one hour. A
PostgreSQL session advisory lock prevents a scheduled run, manual refresh, and
reset from executing concurrently. On shutdown (SIGTERM) the refresh stops at the
next stage boundary and marks its release failed instead of being killed
mid-transaction.

Health (`--health-file`): a background heartbeat rewrites the file every minute
while the worker is healthy, and removes it while unhealthy. Healthy means the
process is running **and** either a refresh is in progress (including the first
import on an empty database) or a published release exists that is younger than
`--interval-days` plus two days. A failed refresh therefore keeps the worker
healthy while the last good release is current. `real-estate-etl healthcheck
--health-file <path>` also fails when the heartbeat is older than five minutes.
The API does not depend on this: it reads readiness from the publication tables.

Each incremental run:

- reads successful national product-years from `source_files`;
- imports only missing BUY years from 2007 and RENT years from 2013;
- downloads the current and previous year again (GURS keeps adding late
  registrations), skips unchanged archives by checksum, and removes the
  superseded local copies;
- keeps valid ZIPs in the `pipeline_data` Docker volume;
- refreshes GURS RPE boundaries and the optional context sources (SURS, Banka
  Slovenije, ECB, GURS buildings and parts of buildings, and the building
  registers: the energy-certificate register, GURS generalised values per
  municipality and the DRSV flood hazard classes; `sync-registers` runs those
  three alone; `ENERGY_CERTIFICATES_URL` pins one register export instead of the
  link on the register page, `DRSV_FLOOD_BASE_URL` overrides the DRSV download
  folder). A failing source keeps its stored values; its
  error is stored in `analytics.analytical_releases.details->'sources'` and listed
  in the "published" log line. A first install has no stored boundaries: when
  the GURS boundary service fails, the worker downloads the published seed
  (`RPE_BOUNDARIES_SEED_URL`, GitHub release `rpe-boundaries`: the same GURS
  data, CC BY 4.0, exported with `make boundaries-seed`), records the source as
  `seed`, and takes the live data again on the next refresh;
- refreshes all deterministic analytics in dependency order inside one
  publication transaction;
- retrains sale and rental models when an archive checksum changed, while
  unchanged current-year downloads retain the published model;
- keeps the previous facts, outliers, indices, and model predictions visible
  until the complete pending release commits.

`analytics.analytical_publication` identifies the active and pending releases.
During processing, `/api/v1/data-status` exposes both the published analytical
cutoff and the newer GURS source cutoff. A failed refresh rolls back derived
changes and leaves the active release untouched. Every release log line carries
`release=<uuid>`, matching `analytics.analytical_releases.id`.

Before every SQL analytics function starts, the worker prints a short statement
of what it derives and whether the operation is non-destructive. In particular,
outlier stages mark statistical deviations and update representative-sample
eligibility; they never delete the underlying GURS transaction.

Model refreshes likewise announce the sale and rental learning populations
before fitting starts: the target, per-property-group separation, duplicate and
strict-land eligibility, and leakage-safe time-ordered selection/calibration.
Every stage also logs the exact schema-qualified database tables it affects and
explains whether it rebuilds rows, inserts a version, or updates specific
eligibility, outlier, duplicate, or publication fields. Shared audit
bookkeeping such as `analytics.refresh_runs` is intentionally omitted from
these short destination lists.

The complete numbered analytics plan is logged before its first SQL function
starts and is the actual sequential execution order. The model plan is also
printed up front: sale completes before rent starts. It separately discloses
bounded property-group parallelism inside the currently active sale or rental
population so the log never implies that all model fits are sequential.

Configure the loop in the repository `.env`:

```dotenv
REFRESH_INTERVAL_DAYS=14
REFRESH_RETRY_HOURS=1
LOG_LEVEL=INFO
```

Operational messages use Python logging on stdout, so they remain visible in
`docker compose logs`. `INFO` includes plans, progress, database effects, and
completion summaries. Use `LOG_LEVEL=WARNING` for quieter scheduled operation
or `LOG_LEVEL=DEBUG` when additional debug messages are available. Routine
`httpx` request summaries—including signed download URLs—are debug-only and do
not appear at the default `INFO` level. CLI reports that are explicit command
results remain plain terminal output.

## Commands

Start the entire system and wait for the initial pipeline run:

```bash
docker compose up -d --build --wait
docker compose logs -f pipeline-worker
```

Run immediately:

```bash
docker compose run --rm pipeline-worker \
  refresh-system --output-dir /data/raw
```

Refresh only deterministic SQL analytics:

```bash
docker compose run --rm pipeline-worker refresh-analytics
```

Long-running SQL analytics stages print a heartbeat every 15 seconds with the
stage name and elapsed time, followed by the exact affected-row count when the
atomic PostgreSQL statement completes. Set
`ANALYTICS_PROGRESS_INTERVAL_SECONDS` on the worker to use a different
interval. PostgreSQL does not expose a reliable intermediate inserted-row
count for these set-based transactional refreshes, so the heartbeat does not
claim an estimated percentage.

Reset and rebuild imported/derived market data:

```bash
docker compose run --rm pipeline-worker \
  reset-and-repopulate --confirm-reset --output-dir /data/raw
```

Reset is intentionally explicit and destructive. It removes source-file
ledger rows, imported transactions/components, analytical facts, anomaly
signals, model runs/predictions, and index vintages. It preserves users,
sessions, preferences, classification tables, the completed-bootstrap marker,
and cached ZIP archives. Consequently, reset/repopulate does not retrain the
models; run `refresh-models` explicitly afterward if valuation outputs are
required.

Follow model training and validation output with:

```bash
docker compose logs -f pipeline-worker
```

For each sale/rental property group, model selection evaluates 20 candidate
configurations—10 Ridge, 6 Elastic Net, and 4 histogram-gradient-boosting—on
every valid expanding temporal fold. It then performs one final-holdout fit,
one building-first grouped-robustness fit, and one full-population production
fit. A group with 16 folds therefore performs approximately
`20 × 16 + 3 = 323` supervised fits. After all groups for sales or rentals are
finished, one separate Isolation Forest is trained for that complete
transaction-kind population. The detailed execution sequence, split rules,
fit-count formula, and persistence behavior are documented under “End-to-end
training execution and fit count” in
[../../docs/statistical-methodology.md](../../docs/statistical-methodology.md).

`--workers` controls bounded property-group concurrency during model
selection and Isolation Forest parallelism. Independent property groups run in
parallel, while database persistence remains single-threaded and transactional.
The Docker worker pins native BLAS/OpenMP pools to one thread per fit to avoid
nested oversubscription. For example:

```bash
docker compose run --rm pipeline-worker refresh-models --workers 6
```

Candidate models share only fold-local transformed feature matrices. Imputation,
scaling, category-frequency decisions, and one-hot encoding are fitted once per
temporal fold instead of once per candidate, while remaining isolated from all
later folds and the final holdout. This is an accuracy-neutral runtime
optimization; it does not reduce candidates, years, rows, or validation work.
Estimator fit time, shared fold-preprocessing time, and total optimization wall
time are persisted separately, avoiding duplicated runtime accounting.

Progress output reports the transaction kind, property-group position,
candidate position, progress at approximately 10% intervals, elapsed time, and
rolling ETA. A typical sequence is:

```text
[models] transaction kind 1/2 starting: sale
[sale model] property groups=5; parallel workers=5; database persistence remains single-threaded
[sale model · apartment · group 1/5] fit plan: 20 candidates × 16 folds = 320 candidate fits, plus holdout, grouped, and production stages
[sale model · apartment · group 1/5] progress 96/320 (30.0%): candidate 6/20, fold 16/16; elapsed=..., ETA=...
[sale model] group completion 3/5 (60.0%); elapsed=...; ETA=...
[models] transaction kind completion 1/2 (50.0%); elapsed=...; ETA=...
```

Each property group's ETA is based on its completed candidate fits; group and
transaction-kind ETAs are rolling estimates and may change when differently
sized populations or estimator families complete.

Set `MODEL_DETAILED_PROGRESS=true` when diagnosing model training to restore a
line for every temporal-fold fit. Concise milestone logging is the default
because several property groups write progress concurrently.

Each completed sale/rent model prints overall temporal-holdout metrics,
90% interval coverage, property-group diagnostics, comparison with a simple
training-median baseline, building-first grouped-holdout performance, and
warnings for materially low overall interval coverage. To rerun only model
training:

```bash
docker compose run --rm pipeline-worker refresh-models --workers 6
```

## Tests

Docker-only, using the image's `test` target (installs `.[dev,ml]` and `tests/`):

```bash
docker build --target test -t real-estate-data-pipeline:test apps/data-pipeline
docker run --rm real-estate-data-pipeline:test
```

Or with a local virtual environment (Python 3.11+):

```bash
python3 -m venv .venv
.venv/bin/pip install -e "apps/data-pipeline[dev,ml]"
cd apps/data-pipeline
../../.venv/bin/ruff check .
../../.venv/bin/pytest -q
```

`pyproject.toml` is the only dependency list.

Database integration tests require `TEST_DATABASE_URL` to point to a disposable
PostGIS database with **all** `database/migrations/*.sql` files applied in order
before running pytest. In particular, publication tests require migration 036.
Without `TEST_DATABASE_URL`, database integration tests are skipped; a passing
unit-only run does not verify them. CI migrates its fresh database before the
Python tests and then runs the Go tests against that schema. For changes to
database setup or publication, verify this fresh-database sequence before
pushing; tests against an already populated development database can miss
missing migrations or incorrect setup order.

## Importing GURS archives from the CLI

The normal runtime does not need a host Python installation. Contributors who
want IDE debugging and local pytest execution can optionally create `.venv`:

```bash
make setup
```

The following low-level commands use that optional development environment. Outside the container, point downloads at a writable directory first:

```bash
export RAW_DATA_DIR=data/raw
```

### Load downloaded national samples

```bash
.venv/bin/real-estate-etl sync-reference-data
.venv/bin/real-estate-etl import data/raw/ETN_SLO_2007_KPP.zip
.venv/bin/real-estate-etl import data/raw/ETN_SLO_2013_NP.zip
```

### Fetch one national dataset

Download national BUY or RENT data for one year:

```bash
.venv/bin/real-estate-etl fetch-national --type sales --year 2026
.venv/bin/real-estate-etl fetch-national --type rent --year 2026
```

Import a downloaded archive:

```bash
.venv/bin/real-estate-etl import data/raw/ETN_SLO_2026_KPP_YYYYMMDD.zip
```

### Import all national BUY and RENT history

The primary command downloads and imports every national yearly dataset:

```bash
make import-data
```

For 2007–2026 there are up to 34 product-years:

- 20 national BUY archives for 2007–2026
- 14 national RENT archives for 2013–2026

The newest product-year may be listed by GURS before its ZIP is ready. Such a
`WARNING`/missing-size response is reported as `unavailable`, does not fail the
run, and is checked again by the next scheduled refresh.

The command skips national dataset/year combinations already recorded in `source_files`, so it is safe to stop and restart. To retrieve current source versions again and replace existing snapshots, add `--force`:

```bash
.venv/bin/real-estate-etl refresh-all-data --force
```

To stop at a specific year, use `--end-year`.

Downloads use up to six parallel workers by default while database imports remain serial to avoid contention on shared reference and codebook tables. The importer detects the machine's logical CPU-thread count and will not allow a worker count above it. Select a different count with:

```bash
make import-data WORKERS=8
```

The startup message prints both the selected worker count and the detected logical CPU-thread count. Use fewer workers for a slower connection or to reduce load on the source API.

For troubleshooting, enable detailed per-table row counts, codebook decisions, archive paths, retries, and final timings:

```bash
make import-data-verbose WORKERS=8
```

Without `--verbose`, the importer prints concise download/completion progress plus warnings and the final summary.

The national source is preferred over municipality archives. A comparison of BUY 2007 showed that the national archive contained every unique transaction from all 212 municipality archives plus six additional transactions, while avoiding duplicated cross-municipality rows. The older `fetch`, `refresh`, and `refresh-all-sales` commands remain available only for targeted municipality diagnostics and fallback use.

The download/import pipeline is bounded to twice the worker count, so it does not queue thousands of archives in memory. Each worker keeps a reusable HTTP connection. PostgreSQL imports use `COPY`, and identical codebook CSVs are imported only once by checksum.

All HTTP calls (GURS, RPE, SURS, Banka Slovenije, ECB) go through `real_estate_etl/http_client.py`: one timeout policy, status checks, and up to five attempts with exponential backoff for transient errors only (connection resets, timeouts, HTTP 408/425/429 and 5xx). Client errors such as 400 or 404 fail immediately. Each archive retry requests a fresh download token. Downloads stream to a `.part` file that is validated and renamed, and removed on any failure, so no truncated archive is left behind. An exhausted retry still stops safely; rerunning the command reuses completed ZIPs and skips committed database snapshots.

At the end, the command reports total elapsed time and cumulative stage timings:

```text
Finished: imported=..., already_imported=..., unavailable=..., elapsed=...,
download_worker_time=..., member_import=..., other_database=...
```

`download_worker_time` is cumulative across parallel workers, so it can be greater than wall-clock `elapsed` time. `member_import` is CSV parsing plus the PostgreSQL `COPY` it streams into; `other_database` is source registration, snapshot deletion and codebooks.

## Source-data rules

Building, parcel, and rented-space tables preserve every CSV source row, including historical unregistered records without complete cadastral identifiers or cadastral municipality codes. Reimporting a national dataset/year replaces its prior database snapshot before loading the new archive.

National BUY transaction rows do not contain `RPE_OBCINE_SIFRA`. Their locations are represented by the associated building-part and parcel rows, which contain municipality and cadastral municipality information. This also correctly supports transactions involving properties in more than one municipality.

Historical cadastral municipality codes found in source archives are retained even when they are no longer returned by the current cadastral-municipality API endpoint.

Source-system zero-date sentinels such as `00.00.0000` are stored as SQL `NULL` rather than treated as valid calendar dates.

## Library choices

- **[HTTPX](https://www.python-httpx.org/)** provides connection pooling, streaming downloads, and explicit timeout/status handling.
- **[Tenacity](https://tenacity.readthedocs.io/en/stable/)** provides bounded exponential retry behavior for transient transport and server failures.
- **psycopg 3** streams rows through PostgreSQL `COPY`; ZIP members and
  codebooks are processed as streams or bounded batches. SQLAlchemy and pandas
  are intentionally not used because they would add memory and abstraction
  overhead to the bulk-loading path.
- **pytest** covers conversion, retry, resume, historical edge cases, and isolated PostgreSQL integration.
- **[Ruff](https://docs.astral.sh/ruff/)** enforces imports, correctness rules, modernization, and style locally and in GitHub Actions.

The package installs a `real-estate-etl` executable, so developers do not need to manage `PYTHONPATH` manually.

The PostgreSQL tables remain in `database/migrations`, not Python. CSV mappings are intentionally kept as one declarative registry rather than one file per table: they are source-to-destination translation rules, and keeping BUY and RENT mappings together makes schema drift comparisons and validation easier. If the number of source products grows substantially, that registry can be moved intact into `mappings.py` without changing the importer.
