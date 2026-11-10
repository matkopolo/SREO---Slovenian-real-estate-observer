# Development guidelines

This monorepo favors conventional tooling and cohesive modules over arbitrary
file-size targets. Split code when a unit has a distinct reason to change,
dependency boundary, or independently testable responsibility.

## Go API

- Keep executable wiring in `cmd/real-estate-api`; keep server implementation in
  `internal` so other modules cannot depend on private application packages.
- Organize packages by capability (`analytics`, `geography`, `construction`,
  `httpapi`), not by generic layers such as `utils`.
- Keep names short and idiomatic: lowercase package names, MixedCaps
  identifiers, `ID` rather than `Id`, and no redundant package-name prefix.
- Accept `context.Context` as the first argument for database and request work.
- Return and wrap errors; handlers translate known domain errors into HTTP
  responses. Do not panic for expected failures.
- Define small interfaces at the consumer boundary. Avoid interfaces that only
  mirror an implementation without enabling substitution.
- Keep SQL visible in repository methods. Bound queries, pagination, map
  extents, connection pools, request bodies, and server timeouts.
- Let `gofmt` own formatting. Every change must pass `go vet`, `staticcheck`,
  `govulncheck` and `go test -race ./...`.
- Keep Go tests beside the package as `*_test.go`. This is the native Go test
  convention and allows package-internal or external-package tests as needed.
  Integration tests use the `_integration_test.go` suffix and skip when
  `TEST_DATABASE_URL` is unavailable.
- `internal/httpapi/routes.go` is the route source of truth. The OpenAPI test
  fails if runtime operations and the contract diverge.

## Python data pipeline

- Keep the installable package in `apps/data-pipeline/real_estate_etl` and
  executable behavior behind `real-estate-etl` / `python -m
  real_estate_etl.cli`.
- Modules have one primary responsibility:
  - `api.py`: resilient JGP HTTP transport and atomic downloads;
  - `importer.py`: CSV mapping, type conversion, and transactional COPY;
  - `pipeline.py`: reference synchronization and bounded concurrent download
    orchestration;
  - `geography.py`: GURS RPE boundary ingestion;
  - `modeling.py`: offline statistical model refreshes;
  - `cli.py`: argument parsing and command dispatch;
  - `settings.py` / `models.py`: immutable configuration and shared value
    types.
- Keep database DDL in `database/migrations`, not embedded as table-creation
  logic in Python. The worker connects as `real_estate_pipeline`, which has DML
  but no DDL (temporary tables are allowed); a new privilege need is a migration.
- Use type hints for public functions and dataclasses for data passed across
  modules. Prefer explicit dependencies and pure helpers where practical.
- Never load the complete source dataset into memory. Downloads may run in
  parallel, while database imports remain sequential on their owning
  connection.
- Keep Python tests in `apps/data-pipeline/tests`. A separate test tree is
  conventional with pytest and cleanly separates unit/integration fixtures
  from the installed package.
- Unit tests must not require network or PostgreSQL. Integration tests are
  marked `integration`, use isolated schemas, and require
  `TEST_DATABASE_URL`.
- Every change must pass Ruff and pytest. New behavior needs tests at the
  lowest useful level.
- One-off research scripts live in `apps/data-pipeline/research/` with a README
  saying how to reproduce them; they are not part of the package or the lint gate.

## Repository workflow

Before committing:

```bash
make lint
make test
git diff --check
```

All targets run their tools in containers; no host Python, Go or Node is
needed. Database integration tests need a disposable, migrated database in
`TEST_DATABASE_URL`.

Keep generated data, virtual environments, caches, model artifacts, secrets,
and downloaded ZIP files out of Git. Commit migrations and OpenAPI changes
with the code that consumes them. Prefer focused commits with imperative
messages.

## TypeScript frontend

See [frontend architecture](frontend.md) for the full layout.

- `apps/observer/src`: `components/App.tsx` (shell and page switch), `views/`
  (one file per page or page part), `components/` (feature components with their
  CSS next to them), `api.ts` (the only API client, typed from the generated
  contract in `generated/`), `url-state.ts` (the only reader and writer of the
  hash state), `hooks/useLoad.ts` (keyed loading), `i18n/` (translations).
- Every visible text is Slovenian inside `t()`/`tx()`, with its English entry in
  `src/i18n/en/*.ts` and terms from `src/i18n/GLOSSARY.md`.
- Use strict TypeScript, accessible native controls, visible focus states, and
  responsive layouts that keep the map and primary evidence ahead of filters on
  mobile.
- Treat sample size, outlier exclusions, source state, loading, and API error
  states as part of the visualization, not incidental metadata. Never replace an
  unavailable statistic with a made-up value.
- No third-party CDN at runtime except the OpenFreeMap tiles: fonts are
  self-hosted, and the map needs no token.
- Every change must pass `npm run lint`, `npm run typecheck`, `npm test` (Vitest,
  including the i18n audit and the API coverage test), the contract-drift check
  and the image build (`tsc && vite build`, then `nginx -t`). CI also runs
  `npm audit --omit=dev --audit-level=high`.

## Why the test layouts differ

Go discovers package tests from adjacent `*_test.go` files, so moving Go tests
into a separate root folder would make imports and access needlessly awkward.
Pytest supports either layout; this project keeps Python tests outside the
package because it has functional and PostgreSQL integration tests and because
that layout tests the installed package boundary.

## Visual Studio Code

Open the repository folder in VS Code (`code .`). Shared configuration in
`.vscode/` provides:

- recommended extensions: Python/Pylance/Ruff, Go, ESLint/Prettier, Container
  Tools, PostgreSQL, Makefile and YAML (accept **Install Workspace Recommended
  Extensions**);
- Ruff formatting for Python, Go formatting and import organization, and
  Prettier for TypeScript/React;
- pytest discovery from `apps/data-pipeline/tests` (point the interpreter at a
  local virtual environment if you want editor test runs; the Makefile does not
  need one);
- tasks (**Terminal → Run Task**) for the database, API, observer and pipeline:
  start, test, lint and logs;
- debugger configurations for the Go API and the Python ETL CLI (**F5**).
