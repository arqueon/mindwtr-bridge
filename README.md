# mindwtr-bridge

*[Léeme en español](README.es.md)*

A bridge between **Vikunja** (the `ANYTYPE` hierarchy, fed by
[vikunja-anytype-sync](../vikunja-anytype-sync)) and **Mindwtr** (a GTD app that
syncs its whole state as a single `data.json` over WebDAV on Nextcloud). It
closes the **Anytype ⟷ Vikunja ⟷ Mindwtr** loop. The bridge only ever talks to
Vikunja: anything created or changed in Mindwtr lands there first, and ATVK is
the only component that writes to Anytype afterwards.

```
Anytype ⟷ (atvk, every 3 min) ⟷ Vikunja[ANYTYPE] ⟷ (this bridge, every 3 min) ⟷ data.json
```

## What it syncs

Vikunja's label namespace is partitioned into three disjoint subsets:

| Subset | Mindwtr field | Reach |
|---|---|---|
| `GTD: Next/Waiting/Someday/Reference` | `status` (inbox = no GTD label) | full loop up to Anytype (tags) |
| `@*` | `contexts` | full loop |
| everything else | `tags` | full loop |

Bidirectional on top of that: `done` (Vikunja recurring tasks are V→M only),
`priority` (low/medium/high/urgent ↔ 1–4, full loop through atvk), `due_date`
and `startTime` (day granularity in `timezone`), and
`isFocusedToday ↔ is_favorite` (Vikunja only). V→M only, reverting local edits:
`title`, project and area.

The original description is **never** copied verbatim. The bridge strips
invitations and capabilities, Anytype URIs and technical markers, converts
what is left to readable text, and copies it V→M only. If the description has
already been edited in Mindwtr, that edit wins: only empty text, or text still
managed by the bridge, gets updated. New tasks and projects inside a managed
area *are* created from Mindwtr, but exclusively in Vikunja — never through the
Anytype API.

How it lays things out in Mindwtr: **one area per Space** (`Our Space 🔥`,
`Academia`, `UDGPlus`) and **one Mindwtr project per Anytype project**; tasks in
`00 · Sin proyecto` go straight to the area. Local GTD fields (reviewAt, energy,
estimate, checklist, Waiting-For people, …) are yours: the bridge always
preserves them and never syncs them.

## Write guarantees

- **Identity**: the mirror's uuid ↔ the Vikunja task id in `task_map`
  (PostgreSQL `mindwtr_sync`) — never by title.
- The ATVK marker is stored alongside the mapping, so when deleting a project
  replaces the Vikunja ids of its tasks, the Mindwtr UUID survives.
- **Per-field three-way merge** (`task_field_state.last_common_value`, policy
  `vikunja_wins` on a simultaneous clash).
- **Atomic WebDAV**: GET with ETag → PUT `If-Match`. A 412 (the app wrote in
  the middle of the cycle) aborts the Mindwtr side and retries next cycle. The
  file read is backed up before every PUT (`backups/`, 14 days).
- A transient failure reading `data.json` (5xx, 429, timeout, network) does not
  fail the run: it reports `skipped_transient` and waits for the next cycle. A
  4xx keeps failing loudly — that one will not fix itself.
- **App protocol**: every mutated entity carries `rev+1` and `revBy` set to the
  bridge's own device uuid (`bridge_state.device_uuid`).
- Tasks deleted or archived locally in Mindwtr (a `deletedAt` tombstone) become
  `dismissed`: never recreated, and they never touch Vikunja.
- One writer at a time: a PostgreSQL advisory lock per cycle.
- The real cycle honours the shared maintenance lock at
  `/run/atvk-maintenance/atvk-mindwtr.lock`; during maintenance it returns
  `skipped_maintenance` without reading or writing WebDAV or Vikunja. `dry-run`
  stays available for checking.

## Operating it

```sh
node src/cli.js dry-run       # plan, writes nothing
node src/cli.js reconcile     # one real cycle (what the timer runs)
node src/cli.js seed-labels   # ensure the 4 GTD labels exist in Vikunja
node src/cli.js retire-task <vikunja_task_id>   # roll a pilot task back
node src/cli.js verify        # cross-inventory of all three sides
scripts/healthcheck.sh        # last cycle under 10 min and error-free
```

Deployed on sinope at `/home/sinope/mindwtr-bridge`, on a systemd timer every
3 minutes (`scripts/install-systemd.sh`). Secrets live in `secrets/` with mode
0600: `vikunja-api-token`, `webdav-credentials` (`user:app-password`) and
`postgres-url`. `scripts/init-db.sh` creates the database, applies the
migrations and generates the `device_uuid`.

Neither `anytype-api-key` nor access to `anytype_sync` is required.

## Rollout, in phases

1. **Dry-run** for a few days: `dry-run` should list only `create_mirror` for
   tasks under `ANYTYPE`, never personal Mindwtr tasks.
2. **Pilot**: set `config/bridge.json → pilot_task_ids: [<id>]`, run a real
   cycle, and check the full loop (GTD status → label → Anytype tag via atvk,
   and `done` coming back). `retire-task` reverts all of it.
3. **Full scope**: empty `pilot_task_ids`. The first pass creates ~81 mirrors
   in a single PUT.
4. Retire the earlier spike (`vikunja-mindwtr-sync`) and its cron job.

## Known limits

- The bridge never deletes remote objects because of a Mindwtr tombstone; it
  marks them `dismissed`. Deleting Vikunja Projects in Anytype belongs to ATVK.
- Descriptions travel sanitised and V→M only; local notes take precedence.
- A simultaneous field-level conflict resolves in Vikunja's favour.
- GTD state lives as Vikunja labels: if someone hand-applies two `GTD: *`
  labels, the most actionable one wins (Next > Waiting > Someday > Reference)
  and a warning is recorded.
