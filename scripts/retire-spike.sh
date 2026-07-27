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
ROOT_ID="$(curl -s -H "Authorization: Bearer $TOKEN" "$API/projects?per_page=100" \
  | python3 -c "import json,sys; ps=json.load(sys.stdin); print(next((p['id'] for p in ps if p['title']=='MINDWTR' and p.get('parent_project_id',0)==0), ''))")"
if [ -z "$ROOT_ID" ]; then
  echo "   no existe proyecto raíz MINDWTR (ok)"
  exit 0
fi

SNAP="$HERE/backups/mindwtr-subtree-$STAMP.json"
mkdir -p "$HERE/backups"
python3 - "$TOKEN" "$API" "$ROOT_ID" "$SNAP" <<'EOF'
import json, sys, urllib.request
token, api, root_id, out = sys.argv[1:5]
def get(path):
    req = urllib.request.Request(f"{api}/{path}", headers={"Authorization": f"Bearer {token}"})
    return json.load(urllib.request.urlopen(req))
projects = get("projects?per_page=100")
subtree = [p for p in projects if p["id"] == int(root_id) or p.get("parent_project_id") == int(root_id)]
ids = {p["id"] for p in subtree}
subtree += [p for p in projects if p.get("parent_project_id") in ids and p["id"] not in ids]
snapshot = {"projects": subtree, "tasks": {}}
for p in snapshot["projects"]:
    snapshot["tasks"][p["id"]] = get(f"projects/{p['id']}/tasks?per_page=100")
json.dump(snapshot, open(out, "w"), ensure_ascii=False, indent=2)
print(f"   snapshot: {out} ({sum(len(t) for t in snapshot['tasks'].values())} tareas)")
EOF

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"title\": \"ZZ · MINDWTR (retirado $STAMP)\", \"is_archived\": true}" \
  "$API/projects/$ROOT_ID" > /dev/null
echo "   proyecto $ROOT_ID renombrado y archivado; borrar definitivo a los 30 días"
