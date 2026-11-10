# Real-estate API service

The supported runtime is Docker Compose. The API uses a separate least-privilege
database identity; /health/live is independent of the database while /health/ready
verifies connectivity. Redis remains optional and unintegrated.

## Responsibility

`apps/real-estate-api` is a Go HTTP service over PostgreSQL/PostGIS. It exposes
bounded, versioned JSON/GeoJSON endpoints for market analytics, maps,
transactions, buildings, construction, anomalies, indices, valuations,
geography, affordability and demographics. There are no accounts. It does not download GURS data or fit statistical models.

Public routes remain under `/api/v1`; the executable and Docker Compose
service are named `real-estate-api`.

## Architecture

```text
cmd/real-estate-api
  -> config + database pool
  -> httpapi (routing, validation, middleware, JSON)
  -> analytics / geography / identity repositories
  -> PostgreSQL public + analytics schemas
```

Packages under `internal` enforce the application boundary. Handlers parse and
validate input, delegate to repositories, and serialize stable DTOs. SQL owns
filtering and aggregation. The service uses a bounded pgx pool, request IDs,
structured logs, panic recovery, CORS allowlisting, security headers, server
timeouts, graceful shutdown, and readiness checks.

## Endpoint groups

- Health and capabilities: `/health/live`, `/health/ready`, `/api/v1/health`,
  `/api/v1/meta`.
- Geography: list, detail, children, and topology-preserving boundaries.
- Sale/rental statistics: overview, time series, distributions, outliers, and
  transaction extremes.
- Maps: bounded clusters, named geographic summaries, capped property
  points for sales and rentals, and `/api/v1/map/buildings`: agreements grouped
  by building (cadastral code + building number) with the period count and the
  median EUR/m² of representative agreements, busiest first (limit ≤ 5,000).
- Transactions/buildings: agreement composition, contextual comparables,
  cadastral building history, and address search. Search results include total
  and per-property-group sale/rental counts constrained by the requested
  `from`/`to` dates, so clients can suggest a relevant market without guessing
  or switching filters automatically.
- Quality: anomaly list and summary (read-only).
- Models: market indices and versioned transaction valuation estimates with
  uncertainty and diagnostics.
- Economy: `/api/v1/economy/inflation` proxies the official SURS SiStat
  monthly inflation table `H281S`, supports monthly, quarterly, and yearly
  output, and caches the external response for six hours. Inflation is
  national context and is never filtered by property or geography.
- Demographics: `/api/v1/demographics?geographyId=` (Slovenia, statistical
  region or municipality) and `/api/v1/demographics/municipalities` serve SURS
  population by five-year age group, net migration, register-census dwellings,
  tenure and households, plus a modelled yearly estimate of dwellings
  potentially released by owners aged 65+ living alone: Σ age-group population ×
  regional death rate (deaths ÷ 1 January population, last three years) ×
  national living-alone share (census 2021) × the area's owner-occupied share
  (census 2021). Municipal estimates borrow regional death rates and are marked
  `modelled`. It is context, not a forecast of listings or prices; care-home
  residents can raise it. Regions sum their municipalities. Values are loaded
  from `analytics.context_series` (`sync-demography`) and cached for 10 minutes.

The authoritative operation and schema definitions are in
`apps/real-estate-api/openapi/openapi.yaml`.

Property history adds three read-only endpoints:

- `GET /api/v1/sales/transactions/{id}/history`
- `GET /api/v1/sales/statistics/resales` (normal sale population filters)
- `GET /api/v1/economy/inflation-factor?from=YYYY-MM-DD&to=YYYY-MM-DD`

No analytics refresh or model training is performed by these endpoints.
See [property history](property-history.md) for exact identity matching,
pair eligibility, truncation, publication thresholds and monthly CPI semantics.

## Statistical contract

The API distinguishes raw/quality-eligible/representative samples and returns
sample sizes with publication status. Medians and percentiles are primary;
averages are supplementary. Outlier removal is limited to the documented
representative population. A high anomaly review score alone never deletes a
source row. Land defaults to the strict ETN buildable-code population; broader
land scopes require an explicit query parameter.

Common filters include contract dates, property group, geography, land scope,
and inclusive minimum/maximum area. Map requests additionally require a valid
WGS84 bounding box and enforce result limits.

Named map labels for city districts, local communities, and settlements use
the centroid of distinct recorded building locations inside the official GURS
boundary. Locations from sale and rental components across all imported years
are combined and deduplicated on a one-metre D96/TM grid. This places labels
closer to the observed built-up area without weighting repeatedly traded units
more heavily. These locations are ETN observations, not a complete building
inventory or an official town-center designation. Their position is independent
of the current market/date/area filters and viewport, but can change after an
import adds new building locations. With no building evidence, and for broader
geographies, the polygon centroid is used. The anchor is projected into a
20-metre inset of the polygon; shapes with an empty inset fall back to
`ST_PointOnSurface`. This affects label placement only; boundaries, transaction
assignments, sample counts, and prices still use the existing statistical rules.
Spatial indexes restrict building lookup, which runs once per returned local
geography after statistical aggregation, rather than once per transaction.

Transaction context is returned by
`GET /api/v1/sales/transactions/{id}/context` and
`GET /api/v1/rentals/transactions/{id}/context`. It uses one hierarchy for
every sale and rental. It first
returns quality-eligible transactions from the same building: same year and
area within ±15%, adjacent year within ±15%, then other same-year units. A
nearby benchmark is selected only from units within ±15% area and ±8
construction years; these physical tolerances are not widened to fill a thin
cohort. Settlement and other small-area context is likewise
physically matched. Municipality, statistical-region, and national medians are
deliberately broader market context. Each aggregate response exposes the
matching profile and tolerances that produced it. The model estimate remains a
separate final reference rather than being mixed into observed comparables.
The same response adds an adaptive current-market estimate based on weighted
latest-market transactions. This is a backend comparable calculation, not the
trained model returned in the separate `valuation` field. It first uses the
current calendar year, expanding through 1, 2.5, 5, 10, and 20 km while
retaining ±15% area and ±8 construction-year tolerances. Only if no current-year cohort
reaches the 50-comparable target does it combine the previous and current
calendar years. It is not a ±1-year window around the subject transaction.
Comparables of the subject's package composition are searched first; for
houses and land they are also the only ones unless fewer than five exist, for
the other groups every composition is searched when they miss the target and
the larger cohort wins. The response lists the comparables it used, with their
positions, and the subject's own position.
The result returns weighted p25/median/p75 values, sample size, actual radius,
physical tolerances, municipality adjustment, confidence and explicit
fallback warnings. The complete search order, weights, formulas, year example,
and limitations are documented under “Current-market estimate” in
`docs/statistical-methodology.md`.

Comparable packages first require the same deterministic ETN component-type
signature, rather than merely the same number of components. If fewer than
five exact-signature candidates exist, an explicitly warned mixed-composition
fallback is permitted. Persisted near-duplicate pairs retain only their lower
transaction ID in comparable populations; both raw transactions remain stored.
The possible-duplicate rule uses the same cadastral building part, dates within
seven days, and no more than 2% difference in area or amount. It is a
probabilistic analytical flag, not confirmation that either source row is wrong.
Only the higher transaction ID is labelled as possibly duplicated; the lower
canonical record remains unflagged.

See `docs/statistical-methodology.md` for equations, cohorts, model validation,
uncertainty, and known limitations.

## Security and persistence

The API is read-only for the public frontend: there are no accounts, sessions
or saved preferences (removed with migration 044). It connects as
`real_estate_api`, which can read published data but cannot import, migrate,
refresh or modify anything. It is published on `127.0.0.1:8080`; the public
entry point is the observer's same-origin `/api/` proxy. Model outputs are not
appraisals or investment advice.

## Development

```bash
make api-up
make api-fmt
make api-vet
make api-test
make api-build
```

The convenience targets retain the familiar `api-*` spelling, but operate on
the `real-estate-api` Compose service. The service is available at
<http://localhost:8080>; start with `/health/ready`. Go tests are colocated with
their packages, while database-backed integration tests use
`TEST_DATABASE_URL` and run with the race detector in CI.
