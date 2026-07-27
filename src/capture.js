'use strict';

// Carril de captura v2 (docs/capture-lane-v2.md): tareas y proyectos nacidos
// en Mindwtr o en Vikunja se dan a luz en Anytype y entran al circuito
// normal. La API de Anytype se usa SOLO aquí y solo para crear/complementar
// objetos recién nacidos — nunca como borde continuo de sincronización.
//
// Idempotencia: capture_map es el libro mayor. La fila se inserta en estado
// 'creating' ANTES de llamar a la API; si el proceso muere en medio, la fila
// envejecida pasa a 'failed' con aviso (ventana rara, resolución manual).
//
// Adopción sin duplicados:
// - Origen mindwtr: cuando atvk materializa el objeto en Vikunja, el bridge
//   enlaza la tarea Vikunja nueva con el uuid del espejo ORIGINAL.
// - Origen vikunja: el bridge escribe el marcador de procedencia de atvk en
//   la tarea/proyecto Vikunja existente; el bootstrap de atvk lo encuentra y
//   adopta en su task_map/project_map en lugar de crear un duplicado.

const { sha256 } = require('./lib/canonical');
const gtd = require('./gtd-mapping');
const model = require('./mindwtr-model');

// Formatos idénticos a canonical.js de atvk (commit 238f617).
function provenanceMarker(spaceId, objectId) {
  return `<!-- atvk:v1:${sha256(`${spaceId}\u0000${objectId}`).slice(0, 40)} -->`;
}

function projectProvenanceMarker(spaceId, projectId) {
  return `<!-- atvk-project:v1:${sha256(`${spaceId}\u0000${projectId}`).slice(0, 40)} -->`;
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ageMinutes(isoDate, now) {
  const parsed = Date.parse(isoDate ?? '');
  if (!Number.isFinite(parsed)) return Infinity;
  return (now.getTime() - parsed) / 60_000;
}

async function loadAtvkMaps(atvkDb) {
  const channels = (await atvkDb.query(
    `SELECT anytype_space_id, channel_name, task_type_key, due_property_key,
            project_property_key, tags_property_key, vikunja_project_id,
            no_project_vikunja_id
     FROM channel_map WHERE enabled`,
  )).rows;
  const taskRows = (await atvkDb.query(
    'SELECT anytype_space_id, anytype_task_id, vikunja_task_id FROM task_map',
  )).rows;
  const projectRows = (await atvkDb.query(
    'SELECT anytype_space_id, anytype_project_id, vikunja_project_id FROM project_map',
  )).rows;

  return {
    channelByContainer: new Map(channels.map((row) => [Number(row.vikunja_project_id), row])),
    noProjectVikunjaIds: new Set(channels.map((row) => Number(row.no_project_vikunja_id))),
    taskByObjectId: new Map(taskRows.map((row) => [row.anytype_task_id, row])),
    vikunjaTaskIds: new Set(taskRows.map((row) => Number(row.vikunja_task_id)).filter(Boolean)),
    projectByVikunjaId: new Map(projectRows.map((row) => [Number(row.vikunja_project_id), row])),
    projectByObjectId: new Map(projectRows.map((row) => [row.anytype_project_id, row])),
  };
}

// Cachés por Space resueltos perezosamente contra la API.
function makeSpaceResolvers(anytype, atvkMaps, warn) {
  const propertyIdCache = new Map(); // `${space}:${key}` → id
  const projectTypeKeyCache = new Map(); // space → type key de Project

  return {
    async propertyId(spaceId, propertyKey) {
      const cacheKey = `${spaceId}:${propertyKey}`;
      if (propertyIdCache.has(cacheKey)) return propertyIdCache.get(cacheKey);
      const properties = await anytype.listProperties(spaceId);
      for (const property of properties) {
        propertyIdCache.set(`${spaceId}:${property.key}`, property.id);
      }
      const id = propertyIdCache.get(cacheKey) ?? null;
      if (!id) warn(`Space ${spaceId.slice(0, 12)}…: propiedad «${propertyKey}» no encontrada.`);
      return id;
    },
    async projectTypeKey(spaceId) {
      if (projectTypeKeyCache.has(spaceId)) return projectTypeKeyCache.get(spaceId);
      let key = 'project';
      const sample = [...atvkMaps.projectByObjectId.values()]
        .find((row) => row.anytype_space_id === spaceId);
      if (sample) {
        try {
          const object = await anytype.getObject(spaceId, sample.anytype_project_id);
          if (object?.type?.key) key = object.type.key;
        } catch (error) {
          warn(`No se pudo resolver el type de Project en ${spaceId.slice(0, 12)}…: ${error.message}`);
        }
      }
      projectTypeKeyCache.set(spaceId, key);
      return key;
    },
  };
}

// Pone en el objeto los tags con los MISMOS nombres que las labels de la
// tarea Vikunja capturada, para que la siembra inicial de atvk (Anytype
// primero) no borre labels que ya existían.
async function ensureObjectTags({ anytype, resolvers, channel, objectId, labelTitles, warn, actions }) {
  if (!labelTitles.length) return;
  const spaceId = channel.anytype_space_id;
  const propertyId = await resolvers.propertyId(spaceId, channel.tags_property_key || 'tag');
  if (!propertyId) return;
  const existing = await anytype.listTags(spaceId, propertyId);
  const byName = new Map(existing.map((tag) => [
    gtd.normalizeLabelTitle(tag.name).toLowerCase(), tag,
  ]));
  const tagIds = [];
  for (const title of labelTitles) {
    const normalized = gtd.normalizeLabelTitle(title);
    let tag = byName.get(normalized.toLowerCase());
    if (!tag) {
      tag = await anytype.createTag(spaceId, propertyId, { name: normalized, color: 'grey' });
      byName.set(normalized.toLowerCase(), tag);
      actions.push({ type: 'capture_tag_created', space: channel.channel_name, tag: normalized });
    }
    if (tag?.id) tagIds.push(tag.id);
  }
  if (tagIds.length) {
    await anytype.updateObject(spaceId, objectId, {
      properties: [{ key: channel.tags_property_key || 'tag', multi_select: tagIds }],
    });
  }
}

async function createAnytypeTask({ anytype, resolvers, channel, title, descriptionMarkdown, dueDateUtc, linkedProjectObjectId }) {
  const properties = [];
  if (dueDateUtc) {
    properties.push({ key: channel.due_property_key || 'due_date', date: dueDateUtc });
  }
  if (linkedProjectObjectId) {
    properties.push({ key: channel.project_property_key || 'linked_projects', objects: [linkedProjectObjectId] });
  }
  const payload = {
    type_key: channel.task_type_key || 'task',
    name: title,
    ...(descriptionMarkdown ? { body: descriptionMarkdown } : {}),
    ...(properties.length ? { properties } : {}),
  };
  return anytype.createObject(channel.anytype_space_id, payload);
}

// --- Carril completo -------------------------------------------------------
// Devuelve mapas de adopción que reconcile.js consume en su fase de plan:
//   adoptTask: vikunja_task_id → { mindwtrId, captureId }
//   adoptProject: vikunja_project_id → { mindwtrId, captureId }
async function runCaptureLane({
  config,
  db,
  atvkDb,
  anytype,
  vikunja,
  data,
  bridge, // { mappingByVikunja, areaByVikunja, projectByVikunja }
  subtree, // { subtreeEntry, scopedProjectIds, children, containers }
  vikunjaTasks,
  dryRun,
  now,
  warn,
  actions,
}) {
  const result = { adoptTask: new Map(), adoptProject: new Map(), created: 0 };
  if (!config.enable_capture || !anytype || !atvkDb) return result;

  const atvkMaps = await loadAtvkMaps(atvkDb);
  const resolvers = makeSpaceResolvers(anytype, atvkMaps, warn);
  const graceMinutes = config.capture_grace_minutes ?? 5;
  const rows = (await db.query('SELECT * FROM capture_map')).rows;

  const byMindwtrId = new Map(rows.filter((r) => r.mindwtr_id).map((r) => [r.mindwtr_id, r]));
  const byVikunjaTask = new Map(rows.filter((r) => r.kind === 'task' && r.vikunja_id != null).map((r) => [Number(r.vikunja_id), r]));
  const byVikunjaProject = new Map(rows.filter((r) => r.kind === 'project' && r.vikunja_id != null).map((r) => [Number(r.vikunja_id), r]));

  // 0. Higiene: filas 'creating' envejecidas (proceso muerto en medio).
  for (const row of rows) {
    if (row.state === 'creating' && ageMinutes(row.created_at, now) > 15) {
      warn(`capture_map #${row.id} llevaba >15 min en 'creating'; marcada failed (revisar a mano si el objeto llegó a crearse).`);
      if (!dryRun) {
        await db.query("UPDATE capture_map SET state = 'failed', updated_at = now() WHERE id = $1", [row.id]);
      }
      row.state = 'failed';
    }
  }

  // 1. Adopciones.
  for (const row of rows) {
    if (row.state !== 'pending') continue;
    if (row.kind === 'task' && row.origin === 'mindwtr') {
      const atvkRow = atvkMaps.taskByObjectId.get(row.anytype_object_id);
      if (atvkRow?.vikunja_task_id) {
        result.adoptTask.set(Number(atvkRow.vikunja_task_id), { mindwtrId: row.mindwtr_id, captureId: row.id });
      }
    } else if (row.kind === 'task' && row.origin === 'vikunja') {
      if (atvkMaps.vikunjaTaskIds.has(Number(row.vikunja_id))) {
        actions.push({ type: 'capture_adopted', origin: 'vikunja', kind: 'task', vikunja_id: Number(row.vikunja_id) });
        if (!dryRun) {
          await db.query("UPDATE capture_map SET state = 'adopted', updated_at = now() WHERE id = $1", [row.id]);
        }
      }
    } else if (row.kind === 'project' && row.origin === 'mindwtr') {
      const atvkRow = atvkMaps.projectByObjectId.get(row.anytype_object_id);
      if (atvkRow?.vikunja_project_id) {
        result.adoptProject.set(Number(atvkRow.vikunja_project_id), { mindwtrId: row.mindwtr_id, captureId: row.id });
      }
    } else if (row.kind === 'project' && row.origin === 'vikunja') {
      if (atvkMaps.projectByVikunjaId.has(Number(row.vikunja_id))) {
        actions.push({ type: 'capture_adopted', origin: 'vikunja', kind: 'project', vikunja_id: Number(row.vikunja_id) });
        if (!dryRun) {
          await db.query("UPDATE capture_map SET state = 'adopted', updated_at = now() WHERE id = $1", [row.id]);
        }
      }
    }
  }

  // Índices inversos del lado bridge (espejo → circuito).
  const mirrorTaskUuids = new Set([...bridge.mappingByVikunja.values()].map((row) => row.mindwtr_task_id));
  const bridgeAreaByMindwtrId = new Map([...bridge.areaByVikunja.values()].map((row) => [row.mindwtr_area_id, row]));
  const bridgeProjectByMindwtrId = new Map([...bridge.projectByVikunja.values()].map((row) => [row.mindwtr_project_id, row]));

  const insertCreating = async (fields) => {
    const inserted = await db.query(
      `INSERT INTO capture_map (origin, kind, mindwtr_id, vikunja_id, anytype_space_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fields.origin, fields.kind, fields.mindwtrId ?? null, fields.vikunjaId ?? null, fields.spaceId],
    );
    return inserted.rows[0].id;
  };
  const markPending = async (captureId, objectId) => {
    await db.query(
      "UPDATE capture_map SET state = 'pending', anytype_object_id = $2, updated_at = now() WHERE id = $1",
      [captureId, objectId],
    );
  };
  const markFailed = async (captureId, message) => {
    await db.query(
      "UPDATE capture_map SET state = 'failed', detail = $2::jsonb, updated_at = now() WHERE id = $1",
      [captureId, JSON.stringify({ error: message })],
    );
  };

  const dueToUtc = (dateOnly) => (dateOnly
    ? gtd.zonedDateTimeToUtc(dateOnly, config.default_due_time ?? '09:00', config.timezone)
    : null);

  // 2. Capturas nacidas en MINDWTR — proyectos primero (las tareas de un
  // proyecto capturado necesitan su object id como Linked Project).
  const pendingProjectCaptureByMindwtrId = new Map(
    rows.filter((r) => r.kind === 'project' && r.origin === 'mindwtr' && r.mindwtr_id)
      .map((r) => [r.mindwtr_id, r]),
  );

  for (const project of data.projects) {
    if (model.isTombstoned(project) || project.status === 'archived') continue;
    if (!project.areaId || !bridgeAreaByMindwtrId.has(project.areaId)) continue;
    if (bridgeProjectByMindwtrId.has(project.id) || byMindwtrId.has(project.id)) continue;
    const areaRow = bridgeAreaByMindwtrId.get(project.areaId);
    const channel = atvkMaps.channelByContainer.get(Number(areaRow.vikunja_project_id));
    if (!channel) continue;
    actions.push({ type: 'capture_create', origin: 'mindwtr', kind: 'project', title: project.title, space: channel.channel_name });
    if (dryRun) continue;
    const captureId = await insertCreating({ origin: 'mindwtr', kind: 'project', mindwtrId: project.id, spaceId: channel.anytype_space_id });
    try {
      const typeKey = await resolvers.projectTypeKey(channel.anytype_space_id);
      const object = await anytype.createObject(channel.anytype_space_id, { type_key: typeKey, name: project.title });
      await markPending(captureId, object.id);
      pendingProjectCaptureByMindwtrId.set(project.id, { anytype_object_id: object.id, state: 'pending' });
      result.created += 1;
    } catch (error) {
      warn(`Captura de proyecto «${project.title}» falló: ${error.message}`);
      await markFailed(captureId, error.message);
    }
  }

  for (const task of data.tasks) {
    if (model.isTombstoned(task)) continue;
    if (!model.MIRROR_STATUSES.includes(task.status)) continue;
    if (mirrorTaskUuids.has(task.id) || byMindwtrId.has(task.id)) continue;

    let channel = null;
    let linkedProjectObjectId = null;
    if (task.projectId) {
      const projectRow = bridgeProjectByMindwtrId.get(task.projectId);
      if (projectRow) {
        const areaRow = bridge.areaByVikunja.get(Number(projectRow.area_vikunja_project_id));
        channel = areaRow ? atvkMaps.channelByContainer.get(Number(areaRow.vikunja_project_id)) : null;
        const atvkProject = atvkMaps.projectByVikunjaId.get(Number(projectRow.vikunja_project_id));
        linkedProjectObjectId = atvkProject?.anytype_project_id ?? null;
      } else {
        const projectCapture = pendingProjectCaptureByMindwtrId.get(task.projectId);
        if (projectCapture?.anytype_object_id) {
          const captureRow = rows.find((r) => r.mindwtr_id === task.projectId) ?? projectCapture;
          const spaceId = captureRow.anytype_space_id
            ?? [...atvkMaps.channelByContainer.values()][0]?.anytype_space_id;
          channel = [...atvkMaps.channelByContainer.values()]
            .find((c) => c.anytype_space_id === spaceId) ?? null;
          linkedProjectObjectId = projectCapture.anytype_object_id;
        }
        if (!channel) continue; // proyecto personal o captura aún en vuelo
      }
    } else if (task.areaId && bridgeAreaByMindwtrId.has(task.areaId)) {
      const areaRow = bridgeAreaByMindwtrId.get(task.areaId);
      channel = atvkMaps.channelByContainer.get(Number(areaRow.vikunja_project_id));
    }
    if (!channel) continue; // tarea personal

    actions.push({ type: 'capture_create', origin: 'mindwtr', kind: 'task', title: task.title, space: channel.channel_name });
    if (dryRun) continue;
    const captureId = await insertCreating({ origin: 'mindwtr', kind: 'task', mindwtrId: task.id, spaceId: channel.anytype_space_id });
    try {
      const object = await createAnytypeTask({
        anytype,
        resolvers,
        channel,
        title: String(task.title ?? '').trim() || '(sin título)',
        descriptionMarkdown: String(task.description ?? '').trim() || null,
        dueDateUtc: dueToUtc(gtd.mindwtrDateOnly(task.dueDate)),
        linkedProjectObjectId,
      });
      await markPending(captureId, object.id);
      result.created += 1;
    } catch (error) {
      warn(`Captura de tarea «${task.title}» falló: ${error.message}`);
      await markFailed(captureId, error.message);
    }
  }

  // 3. Capturas nacidas en VIKUNJA — proyectos primero, misma razón.
  const captureProjectObjectByVikunjaId = new Map(
    rows.filter((r) => r.kind === 'project' && r.origin === 'vikunja' && r.anytype_object_id)
      .map((r) => [Number(r.vikunja_id), r.anytype_object_id]),
  );

  for (const container of subtree.containers) {
    const channel = atvkMaps.channelByContainer.get(container.id);
    if (!channel) continue;
    for (const project of subtree.children.get(container.id) ?? []) {
      if (project.title === config.no_project_title) continue;
      if (atvkMaps.noProjectVikunjaIds.has(project.id)) continue;
      if (atvkMaps.projectByVikunjaId.has(project.id) || byVikunjaProject.has(project.id)) continue;
      if (String(project.description || '').includes('<!-- atvk')) continue;
      if (ageMinutes(project.created, now) < graceMinutes) continue;
      actions.push({ type: 'capture_create', origin: 'vikunja', kind: 'project', title: project.title, space: channel.channel_name });
      if (dryRun) continue;
      const captureId = await insertCreating({ origin: 'vikunja', kind: 'project', vikunjaId: project.id, spaceId: channel.anytype_space_id });
      try {
        const typeKey = await resolvers.projectTypeKey(channel.anytype_space_id);
        const object = await anytype.createObject(channel.anytype_space_id, { type_key: typeKey, name: project.title });
        const marker = projectProvenanceMarker(channel.anytype_space_id, object.id);
        const description = `${stripHtml(project.description)}\n${marker}`.trim();
        await vikunja.updateProject(project.id, { title: project.title, description });
        await markPending(captureId, object.id);
        captureProjectObjectByVikunjaId.set(project.id, object.id);
        result.created += 1;
      } catch (error) {
        warn(`Captura de proyecto Vikunja «${project.title}» falló: ${error.message}`);
        await markFailed(captureId, error.message);
      }
    }
  }

  for (const [vikunjaTaskId, task] of vikunjaTasks) {
    if (!task || task.done) continue;
    if (!subtree.scopedProjectIds.has(task.project_id)) continue;
    if (atvkMaps.vikunjaTaskIds.has(vikunjaTaskId) || byVikunjaTask.has(vikunjaTaskId)) continue;
    if (String(task.description || '').includes('<!-- atvk')) continue;
    if (ageMinutes(task.created, now) < graceMinutes) continue;

    const entry = subtree.subtreeEntry.get(task.project_id);
    if (!entry) continue;
    const channel = atvkMaps.channelByContainer.get(entry.container.id);
    if (!channel) continue;
    let linkedProjectObjectId = null;
    if (entry.project) {
      linkedProjectObjectId = atvkMaps.projectByVikunjaId.get(entry.project.id)?.anytype_project_id
        ?? captureProjectObjectByVikunjaId.get(entry.project.id)
        ?? null;
      if (!linkedProjectObjectId) continue; // esperar a la captura del proyecto
    }

    actions.push({ type: 'capture_create', origin: 'vikunja', kind: 'task', title: task.title, space: channel.channel_name });
    if (dryRun) continue;
    const captureId = await insertCreating({ origin: 'vikunja', kind: 'task', vikunjaId: vikunjaTaskId, spaceId: channel.anytype_space_id });
    try {
      const object = await createAnytypeTask({
        anytype,
        resolvers,
        channel,
        title: String(task.title ?? '').trim() || '(sin título)',
        descriptionMarkdown: stripHtml(task.description) || null,
        dueDateUtc: gtd.isVikunjaNullDate(task.due_date) ? null : task.due_date,
        linkedProjectObjectId,
      });
      // Tags espejo de las labels actuales: evita que la siembra inicial de
      // atvk (Anytype primero) borre las labels ya presentes en la tarea.
      const labelTitles = (task.labels ?? []).map((label) => label.title).filter(Boolean);
      await ensureObjectTags({ anytype, resolvers, channel, objectId: object.id, labelTitles, warn, actions });
      const marker = provenanceMarker(channel.anytype_space_id, object.id);
      const description = `${String(task.description ?? '')}\n${marker}`.trim();
      await vikunja.updateTask(task, { description });
      await markPending(captureId, object.id);
      result.created += 1;
    } catch (error) {
      warn(`Captura de tarea Vikunja «${task.title}» falló: ${error.message}`);
      await markFailed(captureId, error.message);
    }
  }

  return result;
}

module.exports = {
  ageMinutes,
  loadAtvkMaps,
  projectProvenanceMarker,
  provenanceMarker,
  runCaptureLane,
  stripHtml,
};
