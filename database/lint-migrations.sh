#!/usr/bin/env bash
# Static checks on database/migrations (the rules are in docs/database.md#migrations):
#   - 026+ run inside the runner's transaction: no BEGIN/COMMIT/ROLLBACK of their own;
#   - CREATE TABLE and named CREATE INDEX must be IF NOT EXISTS (reruns and the baseline
#     image must be idempotent); unnamed CREATE INDEX ON ... (temporary tables inside
#     function bodies) and TEMP tables are exempt;
#   - CONCURRENTLY needs the `-- migrate: no-transaction` first line, and such a file
#     must not open a transaction of its own.
# Usage: database/lint-migrations.sh [migrations directory]
set -euo pipefail

dir="${1:-$(cd "$(dirname "$0")" && pwd)/migrations}"
status=0

fail() {
  echo "$1: $2" >&2
  status=1
}

for file in "$dir"/[0-9][0-9][0-9]_*.sql; do
  name="${file##*/}"
  version=$((10#${name%%_*}))
  no_transaction=0
  if head -n 1 "$file" | grep -q '^-- migrate: no-transaction'; then
    no_transaction=1
  fi

  if (( version >= 26 )) && grep -nE '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK)[[:space:]]*;' "$file"; then
    fail "$name" "runs inside the runner's transaction; remove BEGIN/COMMIT"
  fi

  if grep -niE '^[[:space:]]*CREATE[[:space:]]+(UNLOGGED[[:space:]]+)?TABLE[[:space:]]' "$file" \
     | grep -viE 'IF[[:space:]]+NOT[[:space:]]+EXISTS'; then
    fail "$name" "CREATE TABLE without IF NOT EXISTS"
  fi

  if grep -niE '^[[:space:]]*CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[[:space:]]' "$file" \
     | grep -viE 'IF[[:space:]]+NOT[[:space:]]+EXISTS' \
     | grep -viE 'CREATE[[:space:]]+INDEX[[:space:]]+ON[[:space:]]'; then
    fail "$name" "named CREATE INDEX without IF NOT EXISTS"
  fi

  if grep -qiE '\bCONCURRENTLY\b' "$file" && (( no_transaction == 0 )); then
    fail "$name" "uses CONCURRENTLY; the first line must be '-- migrate: no-transaction'"
  fi
  if (( no_transaction )) && grep -qiE '^[[:space:]]*(BEGIN|COMMIT)[[:space:]]*;' "$file"; then
    fail "$name" "a no-transaction migration must not open a transaction"
  fi
done

if (( status == 0 )); then
  echo "migration lint passed ($(ls "$dir"/[0-9][0-9][0-9]_*.sql | wc -l | tr -d ' ') files)"
fi
exit "$status"
