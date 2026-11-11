# SREO — Slovenian Real Estate Observer

Slovenian real-estate analytics built on **actual concluded transactions**, not
advertised listings. SREO imports the national sale (BUY/KPP, from 2007)
and rental (RENT/NP, from 2013) records of the GURS Real Estate Market Register
(ETN), assigns them to official RPE boundaries in PostGIS, and serves
quality-aware market statistics, comparables, property history and valuation
model estimates through a read-only Go API and a map-first web frontend (React +
MapLibre, Slovenian and English). There are no user accounts.

SREO (Slovenian Real Estate Observer) is the product name. Service, database,
volume and container names keep their original technical names, and the Compose
project name is fixed (`name: real_estate`), so volumes are
`real_estate_postgres_data` and `real_estate_pipeline_data` whatever the checkout
folder is called. Renaming either would start an empty database.

## Run it

Docker Compose is the only supported runtime; no host Python, Go, Node.js or
Make is needed. Use Docker Desktop (Windows/macOS) or Docker Engine with Compose
v2 (Linux), AMD64 or ARM64. Give Docker at least 8 GB RAM (12 GB for model
training), plenty of disk for archives and the database, and internet access to
GURS.

```bash
docker compose up -d --build --wait
docker compose logs -f pipeline-worker   # follow the first import
```

Open <http://localhost:3000> (also <http://localhost:3100>, kept so earlier links
work). Switch between Slovenian and English with the SL | EN control. All ports
(3000, 3100, 8080, 5432) are bound to `127.0.0.1` only.

The API and the frontend start as soon as the database is migrated; they do not
wait for the pipeline. On a new database the worker first downloads and imports
the full national GURS history, synchronises boundaries, builds analytics and
trains the initial models, which takes a long time. Until the first release is
published, the frontend shows a data-status banner (`/api/v1/data-status`). After
that, each refresh publishes atomically, so a failed GURS download never takes
the site down: it keeps serving the last good release.

Data lives in named Docker volumes and survives `docker compose down` and
rebuilds. To rebuild all services while keeping data:

```bash
docker compose down --remove-orphans
docker compose up -d --build --wait
```

To start completely empty (deletes market data, model history and cached
downloads):

```bash
docker compose down --volumes --remove-orphans
docker compose up -d --build --wait
```

## What runs

| Service | Role |
|---|---|
| `db` | PostgreSQL 16 + PostGIS on `127.0.0.1:5432`; installs the 001–025 schema baseline on a new volume |
| `database-migrations` | One-shot: applies and records migrations 026+ on every start, then reconciles database roles |
| `pipeline-worker` | Downloads/imports GURS, SURS, Banka Slovenije and ECB data, refreshes analytics, trains models; runs immediately, then every 14 days (wall-clock). Connects as the least-privilege `real_estate_pipeline` role |
| `real-estate-api` | Go API at `127.0.0.1:8080`, read-only for the public frontend, with its own read-only database role |
| `observer` | Web frontend at `:3000` (also `:3100`): market by area, sales lists, value check, trends; Slovenian/English; nginx proxies same-origin `/api/*` to the API |

`db`, `real-estate-api` and `observer` restart automatically
(`restart: unless-stopped`). Each refresh publishes a complete analytical release
atomically; the frontend keeps showing the previous release until the new one
commits. Models retrain on first install and whenever GURS publishes new or
revised archives; set `MODEL_REFRESH_POLICY=manual` in `.env` to disable
automatic training. Copy `.env.example` to `.env` to change any setting.

## Repository

| Path | Contents | Start here |
|---|---|---|
| `apps/data-pipeline/` | Python downloader, importer, analytics/model refresh, CLI | [README](apps/data-pipeline/README.md) |
| `apps/real-estate-api/` | Go API, OpenAPI contract | [README](apps/real-estate-api/README.md) |
| `apps/observer/` | Web frontend: React, MapLibre, bilingual UI (`src/i18n`) | [Frontend](docs/frontend.md) |
| `database/migrations/` | Authoritative schema and incremental migrations | [database architecture](docs/database.md) |
| `database/documentation/` | Column-level data dictionary | [data dictionary](database/documentation/data-dictionary.md) |
| `database/run-migrations.sh`, `database/roles.sql` | Migration runner and repeatable role reconciliation | [migrations](docs/database.md#migrations) |
| `infrastructure/docker/` | Database/migration images and the Compose smoke test | — |
| `apps/data-pipeline/research/` | One-off research scripts (demographics backtest) | [README](apps/data-pipeline/research/demographics-backtest/README.md) |
| `docs/` | Architecture, methodology and policies | see below |

Documentation:

- [Frontend](docs/frontend.md) · [API](docs/real-estate-api.md) · [Database](docs/database.md)
- [Statistical methodology](docs/statistical-methodology.md) · [Model optimisation report](docs/model-optimization-report.md) · [Property history](docs/property-history.md) · [Demographics](docs/demographics.md) (why demography is context only)
- [Data licensing and privacy](docs/data-licensing-privacy.md) · [Backup and recovery](docs/backup-and-recovery.md)
- [Development guidelines](docs/development-guidelines.md) (conventions, test layout, VS Code)

## Common tasks

```bash
docker compose run --rm pipeline-worker refresh-system --output-dir /data/raw   # refresh now
docker compose run --rm pipeline-worker refresh-models --workers 6              # retrain deliberately
docker compose run --rm pipeline-worker sync-demography                         # refresh SURS demographics only
docker compose run --rm pipeline-worker sync-registers --output-dir /data/raw   # energy certificates, GURS generalised values, DRSV flood classes
docker compose up -d --build --force-recreate --no-deps observer                # rebuild only the frontend
```

The [pipeline README](apps/data-pipeline/README.md) covers scheduling, resets,
the import CLI and model reports.

## Checks

```bash
make lint          # Ruff, go vet, staticcheck, ESLint, TypeScript
make test          # pipeline, Go and frontend tests (incl. the translation audit); pipeline DB tests skip without TEST_DATABASE_URL
make api-vulncheck # govulncheck
python3 infrastructure/docker/smoke.py   # disposable fresh-volume Compose startup
```

Database integration tests commit to publication tables, so run them only
against a disposable, fully migrated database:
`make pipeline-test TEST_DATABASE_URL=postgresql://…/real_estate_test`.
Every `make` check runs its tools in containers. CI runs the pipeline, API and
frontend jobs in parallel on a fresh database, then builds every image once,
runs `nginx -t` and the smoke test.

## Data source and licence

Sources: Geodetska uprava Republike Slovenije (GURS): Evidenca trga
nepremičnin (ETN), Register prostorskih enot (RPE), Kataster nepremičnin and
Evidenca vrednotenja, used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.sl); the public
Register energetskih izkaznic (Ministry of the Environment, Climate and Energy,
re-use of public-sector information); DRSV flood hazard classes (CC BY 4.0);
SURS, Banka Slovenije and the ECB for context; map © OpenFreeMap, OpenMapTiles
and OpenStreetMap contributors (ODbL). The data is processed; results are
informative and are not an official or certified valuation. See
[data licensing and privacy](docs/data-licensing-privacy.md).
