PIPELINE_DIR := apps/data-pipeline
PIPELINE_RUN := docker compose run --rm pipeline-worker
# Destructive admin commands (TRUNCATE ... RESTART IDENTITY needs table ownership) run
# as the development superuser instead of the worker's least-privilege role.
ADMIN_DATABASE_URL := postgresql://real_estate:real_estate@db:5432/real_estate
PIPELINE_ADMIN_RUN := docker compose run --rm -e DATABASE_URL=$(ADMIN_DATABASE_URL) pipeline-worker
WORKERS ?= 6
PYTHON_IMAGE ?= python:3.11-slim
PY_RUN := docker run --rm -v "$(CURDIR)/$(PIPELINE_DIR):/src" -v real_estate_pip_cache:/root/.cache/pip -w /src $(PYTHON_IMAGE)
PY_DEV_INSTALL := pip install --quiet --root-user-action=ignore -e '.[dev,ml]'
GO_IMAGE ?= golang:1.26.10-bookworm
API_DIR := apps/real-estate-api
API_TEST_DATABASE_URL ?= postgresql://real_estate:real_estate@host.docker.internal:5432/real_estate
GO_RUN := docker run --rm --add-host=host.docker.internal:host-gateway -v "$(CURDIR)/$(API_DIR):/src" -v real_estate_go_mod_cache:/go/pkg/mod -v real_estate_go_build_cache:/root/.cache/go-build -w /src $(GO_IMAGE)
STATICCHECK_VERSION ?= v0.8.2
GOVULNCHECK_VERSION ?= v1.9.0
WEB_DIR := apps/observer
NODE_IMAGE ?= node:22-bookworm-slim
WEB_NODE_MODULES := real_estate_observer_node_modules
NODE_RUN := docker run --rm -v "$(CURDIR):/repo" -v $(WEB_NODE_MODULES):/repo/$(WEB_DIR)/node_modules -w /repo/$(WEB_DIR) $(NODE_IMAGE)
NPM_CI := npm ci --prefer-offline --no-audit --no-fund >/dev/null
.PHONY: start refresh-system reset-and-repopulate db-up db-migrate db-down db-status analytics-refresh models-refresh api-up api-down api-logs api-fmt api-vet api-staticcheck api-vulncheck api-test api-build web-setup web-up web-down web-logs web-generate-api-types web-contract-drift web-lint web-typecheck web-test web-build lint pipeline-lint test pipeline-test test-unit import-data import-data-verbose

start:
	docker compose up -d --build --wait

refresh-system: db-up
	$(PIPELINE_RUN) refresh-system --workers $(WORKERS) --output-dir /data/raw

reset-and-repopulate: db-up
	$(PIPELINE_ADMIN_RUN) reset-and-repopulate --confirm-reset --workers $(WORKERS) --output-dir /data/raw

db-up:
	docker compose up -d --wait db
	$(MAKE) db-migrate

db-migrate:
	docker compose run --rm database-migrations

analytics-refresh: db-up
	$(PIPELINE_RUN) refresh-analytics

models-refresh: db-up
	$(PIPELINE_RUN) refresh-models --workers $(WORKERS)

db-down:
	docker compose down

db-status:
	docker compose ps

api-up: db-up
	docker compose up -d --build --wait real-estate-api

api-down:
	docker compose stop real-estate-api

api-logs:
	docker compose logs -f real-estate-api

api-fmt:
	$(GO_RUN) gofmt -w .

api-vet:
	$(GO_RUN) go vet ./...

api-staticcheck:
	$(GO_RUN) go run honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION) ./...

api-vulncheck:
	$(GO_RUN) go run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION) ./...

api-test:
	$(GO_RUN) env TEST_DATABASE_URL=$(API_TEST_DATABASE_URL) go test -race ./...

api-build:
	docker compose build real-estate-api

web-setup:
	$(NODE_RUN) npm ci

web-up: api-up
	docker compose up -d --build --wait observer

web-down:
	docker compose stop observer

web-logs:
	docker compose logs -f observer

web-generate-api-types:
	$(NODE_RUN) sh -c "$(NPM_CI) && npm run generate:api-types"

web-contract-drift: web-generate-api-types
	git diff --exit-code -- $(WEB_DIR)/src/generated/api-schema.d.ts

web-lint:
	$(NODE_RUN) sh -c "$(NPM_CI) && npm run lint"

web-typecheck:
	$(NODE_RUN) sh -c "$(NPM_CI) && npm run typecheck"

web-test:
	$(NODE_RUN) sh -c "$(NPM_CI) && npm test"

web-build:
	docker compose build observer

lint: pipeline-lint api-vet api-staticcheck web-lint web-typecheck

pipeline-lint:
	$(PY_RUN) sh -c "$(PY_DEV_INSTALL) && ruff check ."

test: pipeline-test api-test web-test

# Integration tests commit to analytics publication tables, so they never default
# to the development database: pass a disposable, migrated database explicitly,
# e.g. make pipeline-test TEST_DATABASE_URL=postgresql://...@host.docker.internal:5432/real_estate_test
pipeline-test:
	$(PY_RUN) sh -c "$(PY_DEV_INSTALL) && TEST_DATABASE_URL='$(TEST_DATABASE_URL)' pytest -q"

test-unit:
	$(PY_RUN) sh -c "$(PY_DEV_INSTALL) && pytest -q -m 'not integration'"

import-data: db-up
	$(PIPELINE_RUN) refresh-all-data --workers $(WORKERS) --output-dir /data/raw

import-data-verbose: db-up
	$(PIPELINE_RUN) refresh-all-data --workers $(WORKERS) --output-dir /data/raw --verbose
