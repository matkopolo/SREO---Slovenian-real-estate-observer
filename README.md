# DOMOGLASNIK

Slovenian real-estate analytics built on **actual concluded transactions**, not
advertised listings. DOMOGLASNIK imports the national sale (BUY/KPP, from 2007)
and rental (RENT/NP, from 2013) records of the GURS Real Estate Market Register
(ETN), assigns them to official RPE boundaries in PostGIS, and serves
quality-aware market statistics, comparables, property history and valuation
model estimates through a Go API and a map-first Next.js dashboard.

DOMOGLASNIK is the product name. Service, database, volume and container names
keep their original technical names so rebranding never creates a new empty
database.

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

Open <http://localhost:3000>. On a new database the worker first downloads and
imports the full national GURS history, synchronises boundaries, builds
analytics and trains the initial models, so the first start takes a long time.
The API and web become ready after that first refresh succeeds.

Data lives in named Docker volumes and survives `docker compose down` and
rebuilds. To rebuild all services while keeping data:

```bash
docker compose down --remove-orphans
docker compose up -d --build --wait
```

To start completely empty (deletes market data, users, preferences, model
history and cached downloads):

```bash
docker compose down --volumes --remove-orphans
docker compose up -d --build --wait
```

## What runs

| Service | Role |
|---|---|
| `db` | PostgreSQL 16 + PostGIS; installs the 001–025 schema baseline on a new volume |
| `database-migrations` | One-shot: applies and records migrations 026+ on every start |
| `pipeline-worker` | Downloads/imports GURS archives, refreshes analytics, trains models; runs immediately, then every 14 days (wall-clock) |
| `real-estate-api` | Go API at `:8080` with a read-mostly, least-privilege database role |
| `web` | Next.js dashboard at `:3000`; proxies same-origin `/api/*` to the API |

Each refresh publishes a complete analytical release atomically; the dashboard
keeps showing the previous release until the new one commits. Models retrain on
first install and whenever GURS publishes new or revised archives
(`MODEL_REFRESH_POLICY=manual` disables automatic training).

## Repository

| Path | Contents | Start here |
|---|---|---|
| `apps/data-pipeline/` | Python downloader, importer, analytics/model refresh, CLI | [README](apps/data-pipeline/README.md) |
| `apps/real-estate-api/` | Go API, OpenAPI contract | [README](apps/real-estate-api/README.md) |
| `apps/web/` | Next.js dashboard and MapLibre map | [README](apps/web/README.md) |
| `database/migrations/` | Authoritative schema and incremental migrations | [database architecture](docs/database.md) |
| `database/documentation/` | Column-level data dictionary | [data dictionary](database/documentation/data-dictionary.md) |
| `infrastructure/docker/` | Database/migration images and the Compose smoke test | — |
| `docs/` | Architecture, methodology and policies | see below |

Documentation:

- [Frontend](docs/frontend.md) · [API](docs/real-estate-api.md) · [Database](docs/database.md)
- [Statistical methodology](docs/statistical-methodology.md) · [Model optimisation report](docs/model-optimization-report.md) · [Property history](docs/property-history.md)
- [Data licensing and privacy](docs/data-licensing-privacy.md) · [Backup and recovery](docs/backup-and-recovery.md)
- [Development guidelines](docs/development-guidelines.md) (conventions, test layout, VS Code workspace)

## Common tasks

```bash
docker compose run --rm pipeline-worker refresh-system --output-dir /data/raw   # refresh now
docker compose run --rm pipeline-worker refresh-models --workers 6              # retrain deliberately
docker compose up -d --build --force-recreate --no-deps web                     # rebuild only the frontend
```

The [pipeline README](apps/data-pipeline/README.md) covers scheduling, resets,
the import CLI and model reports.

## Checks

```bash
make lint          # Ruff, go vet, ESLint, TypeScript
make test          # pipeline, Go and web tests (pipeline DB tests skip without TEST_DATABASE_URL)
python3 infrastructure/docker/smoke.py   # disposable fresh-volume Compose startup
```

Database integration tests commit to publication tables, so run them only
against a disposable, fully migrated database:
`make pipeline-test TEST_DATABASE_URL=postgresql://…/real_estate_test`.
CI runs every check on a fresh database.

## Data source and licence

Source: Geodetska uprava Republike Slovenije (GURS), Evidenca trga nepremičnin
(ETN) and Register prostorskih enot (RPE), used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.sl). The data is
processed; results are informative and are not an official or certified
valuation. See [data licensing and privacy](docs/data-licensing-privacy.md).
