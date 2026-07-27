#!/usr/bin/env bash
# Fase 4: retiro ordenado del spike vikunja-mindwtr-sync (correr en sinope).
# 1. Quita el cron. 2. Renombra y archiva el subárbol MINDWTR en Vikunja con
# snapshot previo. Las tareas del data.json no se tocan (siguen en la app).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$(cat "$HERE/secrets/vikunja-api-token")"
API="https://tasks.arqueonautis.org/api/v1"
STAMP="$(date +%Y-%m-%d)"

echo "== 1. Cron del spike"
if crontab -l 2>/dev/null | grep -q "vikunja-mindwtr-sync"; then
  crontab -l | grep -v "vikunja-mindwtr-sync" | crontab -
  echo "   cron eliminado"
else
  echo "   sin entrada de cron (ok)"
fi

echo "== 2. Subárbol MINDWTR en Vikunja"
ROOT_ID="$(python3 - "$TOKEN" "$API" <<'PYEOF'
import json, sys, urllib.request
token, api = sys.argv[1:3]
projects, page = [], 1
while True:
    req = urllib.request.Request(f"{api}/projects?per_page=100&page={page}",
                                 headers={"Authorization": f"Bearer {token}", "User-Agent": "mindwtr-bridge/0.1"})
    resp = urllib.request.urlopen(req)
    batch = json.load(resp)
    projects += batch
    total_pages = int(resp.headers.get("x-pagination-total-pages") or 0)
    if page >= total_pages or not batch:
        break
    page += 1
print(next((p["id"] for p in projects if p["title"] == "MINDWTR" and p.get("parent_project_id", 0) == 0), ""))
PYEOF
)"
if [ -z "$ROOT_ID" ]; then
  echo "   no existe proyecto raíz MINDWTR (ok)"
  exit 0
fi

SNAP="$HERE/backups/mindwtr-subtree-$STAMP.json"
mkdir -p "$HERE/backups"
python3 - "$TOKEN" "$API" "$ROOT_ID" "$SNAP" <<'EOF'
import json, sys, urllib.request
token, api, root_id, out = sys.argv[1:5]
def get_resp(path):
    req = urllib.request.Request(f"{api}/{path}", headers={"Authorization": f"Bearer {token}", "User-Agent": "mindwtr-bridge/0.1"})
    return urllib.request.urlopen(req)
def get(path):
    return json.load(get_resp(path))
projects, page = [], 1
while True:
    resp = get_resp(f"projects?per_page=100&page={page}")
    batch = json.load(resp)
    projects += batch
    total_pages = int(resp.headers.get("x-pagination-total-pages") or 0)
    if page >= total_pages or not batch:
        break
    page += 1
subtree = [p for p in projects if p["id"] == int(root_id) or p.get("parent_project_id") == int(root_id)]
ids = {p["id"] for p in subtree}
subtree += [p for p in projects if p.get("parent_project_id") in ids and p["id"] not in ids]
subtree = [p for p in subtree if p["id"] > 0]
snapshot = {"projects": subtree, "tasks": {}}
for p in snapshot["projects"]:
    try:
        snapshot["tasks"][p["id"]] = get(f"projects/{p['id']}/tasks?per_page=100")
    except Exception as error:
        snapshot["tasks"][p["id"]] = {"error": str(error)}
json.dump(snapshot, open(out, "w"), ensure_ascii=False, indent=2)
print(f"   snapshot: {out} ({sum(len(t) for t in snapshot['tasks'].values())} tareas)")
EOF

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"title\": \"ZZ · MINDWTR (retirado $STAMP)\", \"is_archived\": true}" \
  "$API/projects/$ROOT_ID" > /dev/null
echo "   proyecto $ROOT_ID renombrado y archivado; borrar definitivo a los 30 días"
