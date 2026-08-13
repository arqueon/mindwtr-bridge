# mindwtr-bridge

Puente entre **Vikunja** (jerarquía `ANYTYPE`, alimentada por
[vikunja-anytype-sync](../vikunja-anytype-sync)) y **Mindwtr** (app GTD que
sincroniza su estado como un único `data.json` vía WebDAV en Nextcloud).
Cierra el circuito **Anytype ⟷ Vikunja ⟷ Mindwtr**. El bridge sólo habla con
Vikunja: las altas y cambios de Mindwtr llegan primero allí y ATVK es el único
componente que escribe después en Anytype.

```
Anytype ⟷ (atvk, cada 3 min) ⟷ Vikunja[ANYTYPE] ⟷ (este bridge, cada 3 min) ⟷ data.json
```

## Qué sincroniza

Partición del namespace de labels de Vikunja en tres subconjuntos disjuntos:

| Subconjunto | Campo Mindwtr | Alcance |
|---|---|---|
| `GTD: Next/Waiting/Someday/Reference` | `status` (inbox = sin label GTD) | circuito completo hasta Anytype (tags) |
| `@*` | `contexts` | circuito completo |
| resto | `tags` | circuito completo |

Además, bidireccionales: `done` (recurrentes de Vikunja: solo V→M),
`priority` (low/medium/high/urgent ↔ 1–4; circuito completo vía atvk),
`due_date` y `startTime` (granularidad de día en `timezone`),
`isFocusedToday ↔ is_favorite` (solo Vikunja). Solo V→M con reversión de
ediciones locales: `title`, proyecto y área. **Nunca** se copia la
description original: el bridge elimina invitaciones/capabilities, URI de
Anytype y marcadores técnicos, convierte el contenido útil a texto legible y
lo copia solo V→M. Si la descripción ya fue editada en Mindwtr, la conserva;
solo actualiza textos vacíos o todavía administrados por el bridge. Las tareas
y proyectos nuevos de un área administrada sí se crean desde Mindwtr, pero
exclusivamente en Vikunja; nunca mediante la API de Anytype.

Organización en Mindwtr: **Área por Space** (`Our Space 🔥`, `Academia`,
`UDGPlus`) y **proyecto Mindwtr por proyecto Anytype**; tareas de
`00 · Sin proyecto` van directo al área. Campos GTD locales (reviewAt,
energía, estimación, checklist, personas de Waiting For…) son tuyos: el
bridge los preserva siempre y no los sincroniza.

## Cómo escribe (garantías)

- **Identidad**: uuid del espejo ↔ id de tarea Vikunja en `task_map`
  (PostgreSQL `mindwtr_sync`); jamás por título.
- El marcador ATVK se guarda junto al mapping. Si un borrado de proyecto
  sustituye los IDs de sus tareas Vikunja, se conserva el mismo UUID Mindwtr.
- **Three-way merge por campo** (`task_field_state.last_common_value`,
  política `vikunja_wins` en choque simultáneo).
- **WebDAV atómico**: GET con ETag → PUT `If-Match`; un 412 (la app escribió
  en medio) aborta el lado Mindwtr y se reintenta al ciclo siguiente. Backup
  del archivo leído antes de cada PUT (`backups/`, 14 días).
- **Protocolo de la app**: toda entidad mutada lleva `rev+1` y `revBy` =
  uuid de dispositivo propio del bridge (`bridge_state.device_uuid`).
- Tareas borradas/archivadas localmente en Mindwtr (tombstone `deletedAt`) →
  estado `dismissed`: no se recrean nunca y no tocan Vikunja.
- Un solo escritor: advisory lock de PostgreSQL por ciclo.
- El ciclo real consulta el candado compartido
  /run/atvk-maintenance/atvk-mindwtr.lock; durante mantenimiento devuelve
  skipped_maintenance sin leer ni escribir WebDAV o Vikunja. El dry-run
  permanece disponible para verificar.

## Operación

```sh
node src/cli.js dry-run       # plan sin escribir nada
node src/cli.js reconcile     # un ciclo real (lo que corre el timer)
node src/cli.js seed-labels   # asegura las 4 labels GTD en Vikunja
node src/cli.js retire-task <vikunja_task_id>   # revierte un piloto
node src/cli.js verify        # inventario cruzado de los tres lados
scripts/healthcheck.sh        # último ciclo < 10 min y sin errores
```

Despliegue en sinope: `/home/sinope/mindwtr-bridge`, timer systemd cada 3
min (`scripts/install-systemd.sh`). Secretos en `secrets/` modo 0600:
`vikunja-api-token`, `webdav-credentials` (`usuario:app-password`),
`postgres-url`. `scripts/init-db.sh` crea la BD, aplica migraciones y genera
el `device_uuid`.

No se necesita `anytype-api-key` ni acceso a `anytype_sync`.

## Puesta en marcha (resumen de fases)

1. **Dry-run** unos días: `dry-run` debe listar solo `create_mirror` de
   tareas bajo `ANYTYPE`, nunca tareas personales de Mindwtr.
2. **Piloto**: `config/bridge.json → pilot_task_ids: [<id>]`, ciclo real,
   verificar el circuito completo (status GTD → label → tag en Anytype vía
   atvk; done de vuelta). `retire-task` lo revierte todo.
3. **Alcance completo**: vaciar `pilot_task_ids`. La primera pasada crea
   ~81 espejos en un solo PUT.
4. Retirar el spike anterior (`vikunja-mindwtr-sync`) y su cron.

## Límites conocidos

- El bridge no borra objetos remotos por un tombstone Mindwtr; los marca
  `dismissed`. El borrado de Projects Vikunja→Anytype pertenece a ATVK.
- La description viaja saneada y solo V→M; las notas locales tienen prioridad.
- Un conflicto simultáneo campo-a-campo se resuelve a favor de Vikunja.
- El estado GTD vive como labels en Vikunja: si alguien pone dos labels
  `GTD: *` a mano, gana la más accionable (Next > Waiting > Someday >
  Reference) y se registra warning.
