'use strict';

const ATVK_TASK_MARKER = /<!-- atvk:v1:[0-9a-f]{40} -->/i;

function taskProvenanceMarker(task) {
  return String(task?.description ?? '').match(ATVK_TASK_MARKER)?.[0].toLowerCase() ?? null;
}

async function rebindTaskIdentities({
  db,
  taskRows,
  vikunjaTasks,
  dryRun = false,
  actions = [],
  warn = () => {},
}) {
  const result = { seeded: 0, rebound: 0, conflicts: 0 };
  const mappingById = new Map(taskRows.map((row) => [Number(row.vikunja_task_id), row]));
  const liveByMarker = new Map();

  for (const [taskId, task] of vikunjaTasks) {
    if (!task) continue;
    const marker = taskProvenanceMarker(task);
    if (!marker) continue;
    if (!liveByMarker.has(marker)) liveByMarker.set(marker, []);
    liveByMarker.get(marker).push({ taskId: Number(taskId), task });

    const mapping = mappingById.get(Number(taskId));
    if (mapping && !mapping.provenance_marker) {
      actions.push({ type: 'seed_task_provenance', vikunja_task_id: Number(taskId) });
      if (!dryRun) {
        await db.query(
          `UPDATE task_map
           SET provenance_marker = $2,
               updated_at = now()
           WHERE vikunja_task_id = $1
             AND provenance_marker IS NULL`,
          [Number(taskId), marker],
        );
      }
      mapping.provenance_marker = marker;
      result.seeded += 1;
    }
  }

  for (const mapping of taskRows) {
    const oldId = Number(mapping.vikunja_task_id);
    if (vikunjaTasks.get(oldId)) continue;
    const marker = mapping.provenance_marker;
    if (!marker) continue;
    const candidates = liveByMarker.get(String(marker).toLowerCase()) ?? [];
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        result.conflicts += 1;
        warn(`El marcador de la tarea Vikunja ${oldId} aparece en ${candidates.length} tareas vivas; no se reasignó.`);
      }
      continue;
    }
    const newId = candidates[0].taskId;
    const occupied = mappingById.get(newId);
    if (occupied && occupied !== mapping) {
      result.conflicts += 1;
      warn(`La tarea Vikunja ${newId} ya tiene otro espejo Mindwtr; no se reasignó ${oldId}.`);
      continue;
    }
    actions.push({
      type: 'rebind_task_identity',
      old_vikunja_task_id: oldId,
      new_vikunja_task_id: newId,
      mindwtr_task_id: mapping.mindwtr_task_id,
    });
    if (!dryRun) {
      await db.query(
        `UPDATE task_map
         SET vikunja_task_id = $2,
             updated_at = now()
         WHERE vikunja_task_id = $1
           AND provenance_marker = $3`,
        [oldId, newId, marker],
      );
    }
    mappingById.delete(oldId);
    mapping.vikunja_task_id = newId;
    mappingById.set(newId, mapping);
    result.rebound += 1;
  }

  return { ...result, mappingByVikunja: mappingById };
}

module.exports = { ATVK_TASK_MARKER, rebindTaskIdentities, taskProvenanceMarker };
