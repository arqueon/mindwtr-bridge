#!/usr/bin/env bash
# Crea la BD mindwtr_sync, aplica migraciones y siembra bridge_state con un
# device_uuid nuevo (el «dispositivo» con el que el bridge firma sus rev).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PG_URL="$(cat "$HERE/secrets/postgres-url")"
ADMIN_URL="${PG_ADMIN_URL:-$PG_URL}"

DB_NAME="$(echo "$PG_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"

if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
  psql "${ADMIN_URL%/*}/postgres" -c "CREATE DATABASE \"$DB_NAME\""
fi

for migration in "$HERE"/db/migrations/*.sql; do
  echo "== $migration"
  psql "$PG_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

psql "$PG_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO bridge_state (id, device_uuid)
VALUES (1, gen_random_uuid())
ON CONFLICT (id) DO NOTHING;
SQL

psql "$PG_URL" -tAc "SELECT 'device_uuid: ' || device_uuid FROM bridge_state"
