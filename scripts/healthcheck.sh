#!/usr/bin/env bash
# Sano = último sync_run OK hace <10 min y sin errores recientes acumulados.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PG_URL="$(cat "$HERE/secrets/postgres-url")"

LAST="$(psql "$PG_URL" -tAc "
  SELECT extract(epoch FROM now() - started_at)::int || '|' || coalesce(status, 'null')
  FROM sync_run WHERE NOT dry_run ORDER BY id DESC LIMIT 1")"

if [ -z "$LAST" ]; then
  echo "CRIT: sin ejecuciones registradas"
  exit 2
fi

AGE="${LAST%%|*}"
STATUS="${LAST##*|}"
ERRORS="$(psql "$PG_URL" -tAc "SELECT count(*) FROM sync_error WHERE created_at > now() - interval '1 hour'")"

echo "último ciclo: hace ${AGE}s, status=${STATUS}, errores última hora=${ERRORS}"

if [ "$AGE" -gt 600 ]; then
  echo "CRIT: el último ciclo tiene más de 10 minutos"
  exit 2
fi
case "$STATUS" in
  ok|skipped_locked|skipped_etag) ;;
  *) echo "WARN: status=$STATUS"; exit 1 ;;
esac
if [ "$ERRORS" -gt 10 ]; then
  echo "WARN: $ERRORS errores en la última hora"
  exit 1
fi
echo "OK"
