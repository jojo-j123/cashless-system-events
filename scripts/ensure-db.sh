#!/usr/bin/env bash
# Starts a local PostgreSQL cluster if one is not already accepting
# connections, and makes sure the app + test databases exist.
# Safe to run repeatedly. Used by local dev and by `npm test`.
set -euo pipefail

if ! pg_isready -q 2>/dev/null; then
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  else
    service postgresql start >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 30); do
    pg_isready -q 2>/dev/null && break
    sleep 0.5
  done
fi

pg_isready -q || { echo "postgres did not start" >&2; exit 1; }

ensure_database() {
  local name="$1"
  if ! psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${name}'" postgres | grep -q 1; then
    createdb -U postgres "${name}"
  fi
}

ensure_database "${APP_DB_NAME:-cashless}"
ensure_database "${TEST_DB_NAME:-cashless_test}"
