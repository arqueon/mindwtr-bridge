'use strict';

// Carril de captura v3: lo que nace en Mindwtr se materializa únicamente en
// Vikunja. ATVK es el único componente autorizado para crear o modificar
// objetos en Anytype.

const gtd = require('./gtd-mapping');
const model = require('./mindwtr-model');

const CAPTURE_MARKER = /<!-- mindwtr-vikunja:v1:(task|project):([0-9a-f-]{36}) -->/i;

function captureMarker(kind, mindwtrId) {
  if (!['task', 'project'].includes(kind)) throw new Error(`Tipo de captura no válido: ${kind}.`);
  return `<!-- mindwtr-vikunja:v1:${kind}:${String(mindwtrId).toLowerCase()} -->`;
}

function withMarker(body, marker) {
  const normalized = String(body ?? '').trim();
  return `${normalized}${normalized ? '\n' : ''}${marker}`;
}

function markerIdentity(value) {
  const match = String(value ?? '').match(CAPTURE_MARKER);
  return match ? { kind: match[1].toLowerCase(), mindwtrId: match[2].toLowerCase() } : null;
}

function safeTitle(value, fallback) {
  return (String(value ?? '').normalize('NFC').trim() || fallback).slice(0, 250);
}

function noProjectForArea(subtree, areaVikunjaId, title) {
  return (subtree.children.get(Number(areaVikunjaId)) ?? [])
    .find((project) => project.title === title) ?? null;
}

function existingCapturedProject(subtree, mindwtrId) {
  for (const projects of subtree.children.values()) {
    const found = projects.find((project) => {
      const identity = markerIdentity(project.description);
      return identity?.kind === 'project' && identity.mindwtrId === String(mindwtrId).toLowerCase();
    });
    if (found) return found;
  }
  return null;
}

function existingCapturedTask(vikunjaTasks, mindwtrId) {
  for (const task of vikunjaTasks.values()) {
    if (!task) continue;
    const identity = markerIdentity(task.description);
    if (identity?.kind === 'task' && identity.mindwtrId === String(mindwtrId).toLowerCase()) {
      return task;
    }
  }
  return null;
}

async function registerCapture(db, { kind, mindwtrId }) {
  const inserted = await db.query(
    `INSERT INTO capture_map (origin, kind, mindwtr_id, state)
     VALUES ('mindwtr', $1, $2, 'creating')
     ON CONFLICT (mindwtr_id) WHERE mindwtr_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [kind, mindwtrId],
  );
  return inserted.rows[0]?.id ?? null;
}

async function adoptCapture(db, captureId, vikunjaId) {
  await db.query(
    `UPDATE capture_map
     SET state = 'adopted',
         vikunja_id = $2,
         updated_at = now()
     WHERE id = $1`,
    [captureId, Number(vikunjaId)],
  );
}

async function failCapture(db, captureId, message) {
  await db.query(
    `UPDATE capture_map
     SET state = 'failed',
         detail = $2::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [captureId, JSON.stringify({ error: String(message).slice(0, 2000) })],
  );
}

function directTaskPayload(task, config) {
  const dueDate = gtd.mindwtrDateOnly(task.dueDate);
  const startDate = gtd.mindwtrDateOnly(task.startTime);
  const marker = captureMarker('task', task.id);
  return {
    title: safeTitle(task.title, '(sin título)'),
    description: withMarker(task.description, marker),
    done: false,
    priority: gtd.mindwtrPriorityToVikunja(task.priority),
    ...(dueDate ? {
      due_date: gtd.composeVikunjaDate(
        dueDate,
        null,
        config.timezone,
        config.default_due_time,
      ),
    } : {}),
    ...(startDate ? {
      start_date: gtd.composeVikunjaDate(
        startDate,
        null,
        config.timezone,
        config.default_due_time,
      ),
    } : {}),
    ...(task.isFocusedToday ? { is_favorite: true } : {}),
  };
}

// Devuelve mapas de adopción que reconcile.js consume durante el mismo ciclo.
async function runCaptureLane({
  config,
  db,
  vikunja,
  data,
  bridge,
  subtree,
  vikunjaTasks,
  dryRun,
  warn,
  actions,
}) {
  const result = { adoptTask: new Map(), adoptProject: new Map(), created: 0 };
  if (!config.enable_capture) return result;

  const rows = (await db.query('SELECT * FROM capture_map')).rows;
  const captureByMindwtr = new Map(
    rows.filter((row) => row.mindwtr_id).map((row) => [String(row.mindwtr_id), row]),
  );
  const mirrorTaskUuids = new Set(
    [...bridge.mappingByVikunja.values()].map((row) => String(row.mindwtr_task_id)),
  );
  const areaByMindwtr = new Map(
    [...bridge.areaByVikunja.values()].map((row) => [String(row.mindwtr_area_id), row]),
  );
  const projectByMindwtr = new Map(
    [...bridge.projectByVikunja.values()].map((row) => [String(row.mindwtr_project_id), row]),
  );

  // Recupera llamadas Vikunja confirmadas cuyo proceso murió antes de cerrar
  // capture_map. El marcador estable evita crear duplicados.
  for (const row of rows) {
    if (row.origin !== 'mindwtr' || row.state !== 'creating' || !row.mindwtr_id) continue;
    const remote = row.kind === 'project'
      ? existingCapturedProject(subtree, row.mindwtr_id)
      : existingCapturedTask(vikunjaTasks, row.mindwtr_id);
    if (!remote) continue;
    actions.push({
      type: 'capture_recovered',
      kind: row.kind,
      mindwtr_id: String(row.mindwtr_id),
      vikunja_id: Number(remote.id),
    });
    if (!dryRun) await adoptCapture(db, row.id, remote.id);
    row.state = 'adopted';
    row.vikunja_id = Number(remote.id);
    if (row.kind === 'task') {
      result.adoptTask.set(Number(remote.id), { mindwtrId: row.mindwtr_id, captureId: row.id });
    } else {
      result.adoptProject.set(Number(remote.id), { mindwtrId: row.mindwtr_id, captureId: row.id });
    }
  }

  // Proyectos primero para que sus tareas tengan destino en el mismo ciclo.
  for (const project of data.projects) {
    if (model.isTombstoned(project) || project.status === 'archived') continue;
    if (!project.areaId || !areaByMindwtr.has(String(project.areaId))) continue;
    if (projectByMindwtr.has(String(project.id))) continue;

    const prior = captureByMindwtr.get(String(project.id));
    const area = areaByMindwtr.get(String(project.areaId));
    const recovered = existingCapturedProject(subtree, project.id);
    if (prior && prior.state !== 'creating' && !(prior.state === 'adopted' && recovered)) continue;
    actions.push({
      type: recovered ? 'capture_recovered' : 'capture_create_vikunja',
      origin: 'mindwtr',
      kind: 'project',
      title: project.title,
      parent_vikunja_project_id: Number(area.vikunja_project_id),
    });
    if (dryRun) continue;

    const captureId = prior?.id ?? await registerCapture(db, {
      kind: 'project',
      mindwtrId: project.id,
    });
    if (!captureId) continue;
    try {
      const remote = recovered ?? await vikunja.createProject({
        title: safeTitle(project.title, 'Proyecto Mindwtr'),
        description: captureMarker('project', project.id),
        parent_project_id: Number(area.vikunja_project_id),
        is_archived: false,
      });
      await adoptCapture(db, captureId, remote.id);
      await db.query(
        `INSERT INTO project_map (
           vikunja_project_id, mindwtr_project_id,
           area_vikunja_project_id, display_name
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [Number(remote.id), project.id, Number(area.vikunja_project_id), remote.title],
      );
      const row = {
        vikunja_project_id: Number(remote.id),
        mindwtr_project_id: project.id,
        area_vikunja_project_id: Number(area.vikunja_project_id),
        display_name: remote.title,
      };
      bridge.projectByVikunja.set(Number(remote.id), row);
      projectByMindwtr.set(String(project.id), row);
      const children = subtree.children.get(Number(area.vikunja_project_id)) ?? [];
      if (!children.some((candidate) => Number(candidate.id) === Number(remote.id))) {
        children.push(remote);
        subtree.children.set(Number(area.vikunja_project_id), children);
      }
      subtree.subtreeEntry.set(Number(remote.id), {
        container: subtree.containers.find((item) => Number(item.id) === Number(area.vikunja_project_id)),
        project: remote,
      });
      subtree.scopedProjectIds.add(Number(remote.id));
      result.adoptProject.set(Number(remote.id), { mindwtrId: project.id, captureId });
      result.created += recovered ? 0 : 1;
    } catch (error) {
      await failCapture(db, captureId, error.message);
      warn(`Captura Vikunja del proyecto «${project.title}» falló: ${error.message}`);
    }
  }

  for (const task of data.tasks) {
    if (model.isTombstoned(task) || !model.MIRROR_STATUSES.includes(task.status)) continue;
    if (mirrorTaskUuids.has(String(task.id))) continue;
    const prior = captureByMindwtr.get(String(task.id));
    if (prior && prior.state !== 'creating') continue;

    let destination = null;
    if (task.projectId) {
      destination = projectByMindwtr.get(String(task.projectId))?.vikunja_project_id ?? null;
    } else if (task.areaId) {
      const area = areaByMindwtr.get(String(task.areaId));
      destination = area
        ? noProjectForArea(subtree, area.vikunja_project_id, config.no_project_title)?.id
        : null;
    }
    if (!destination) continue; // tarea personal o proyecto todavía no materializado

    const recovered = existingCapturedTask(vikunjaTasks, task.id);
    actions.push({
      type: recovered ? 'capture_recovered' : 'capture_create_vikunja',
      origin: 'mindwtr',
      kind: 'task',
      title: task.title,
      vikunja_project_id: Number(destination),
    });
    if (dryRun) continue;

    const captureId = prior?.id ?? await registerCapture(db, {
      kind: 'task',
      mindwtrId: task.id,
    });
    if (!captureId) continue;
    try {
      const remote = recovered ?? await vikunja.createTask(
        Number(destination),
        directTaskPayload(task, config),
      );
      await adoptCapture(db, captureId, remote.id);
      vikunjaTasks.set(Number(remote.id), remote);
      result.adoptTask.set(Number(remote.id), { mindwtrId: task.id, captureId });
      result.created += recovered ? 0 : 1;
    } catch (error) {
      await failCapture(db, captureId, error.message);
      warn(`Captura Vikunja de la tarea «${task.title}» falló: ${error.message}`);
    }
  }

  return result;
}

module.exports = {
  CAPTURE_MARKER,
  captureMarker,
  markerIdentity,
  runCaptureLane,
  withMarker,
};
