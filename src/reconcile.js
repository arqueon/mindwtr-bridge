'use strict';

// Ciclo de reconciliación Vikunja[ANYTYPE] ⟷ Mindwtr. Un solo escritor:
// 1 lock → 2 GET data.json (ETag E1) → 3 enumerar subtree ANYTYPE →
// 4 cargar estado → 5 infraestructura idempotente → 6 plan por tarea →
// 7 dry-run corta aquí → 8 escrituras Vikunja → 9 mutaciones Mindwtr en
// memoria → 10 PUT If-Match (412 aborta el lado Mindwtr) → 11 commit BD.

const { decideFieldSync, equalValue } = require('./lib/field-sync');
const gtd = require('./gtd-mapping');
const model = require('./mindwtr-model');
const { withAdvisoryLock } = require('./lib/database');
const { sha256 } = require('./lib/canonical');

const LOCK_KEY = 'mindwtr-bridge';
// Para limpiar una fecha, la API de Vikunja espera el cero de Go, no null.
const VIKUNJA_ZERO_DATE = '0001-01-01T00:00:00Z';

// Contrato de campos. `revert: true` = la verdad es siempre Vikunja y una
// edición local se revierte (no hay noop por dirección bloqueada).
// `via`: cómo se escribe el lado Vikunja (update de tarea vs ops de labels).
const FIELD_POLICIES = Object.freeze({
  title: { direction: 'vikunja_to_mindwtr', conflict: 'vikunja_wins', revert: true, via: 'task' },
  done: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'task' },
  gtd_status: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'labels' },
  priority: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'task' },
  due_date: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'task' },
  start_time: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'task' },
  contexts: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'labels' },
  tags: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'labels' },
  focus: { direction: 'bidirectional', conflict: 'vikunja_wins', via: 'task' },
  project: { direction: 'vikunja_to_mindwtr', conflict: 'vikunja_wins', revert: true, via: 'task' },
  area: { direction: 'vikunja_to_mindwtr', conflict: 'vikunja_wins', revert: true, via: 'task' },
});

const snapshotHelpers = {
  mindwtrDateOnly: gtd.mindwtrDateOnly,
  normalizeContexts: gtd.normalizeContexts,
  normalizeTags: gtd.normalizeTags,
};

function vikunjaLogicalSnapshot(task, { timezone, destination }) {
  const partition = gtd.partitionLabels(task.labels ?? []);
  const gtdStatus = gtd.statusFromGtdLabels(partition.gtd);
  return {
    snapshot: {
      title: String(task.title ?? '').normalize('NFC').trim(),
      done: Boolean(task.done),
      gtd_status: task.done ? null : gtdStatus.status,
      priority: gtd.vikunjaPriorityToMindwtr(task.priority),
      due_date: gtd.dateInTimezone(task.due_date, timezone),
      start_time: gtd.dateInTimezone(task.start_date, timezone),
      contexts: gtd.normalizeContexts(partition.contexts),
      tags: gtd.normalizeTags(partition.tags),
      focus: Boolean(task.is_favorite),
      project: destination.projectId,
      area: destination.projectId ? null : destination.areaId,
    },
    partition,
    ambiguousGtd: gtdStatus.ambiguous,
  };
}

// --- Enumeración del subtree ANYTYPE --------------------------------------

function findAnytypeRoot(projects, rootTitle) {
  const root = projects.find(
    (project) => project.title === rootTitle
      && Number(project.parent_project_id ?? 0) === 0,
  );
  if (!root) throw new Error(`No existe el proyecto raíz «${rootTitle}» en Vikunja.`);
  return root;
}

function buildSubtree(projects, root) {
  const containers = projects.filter((project) => project.parent_project_id === root.id);
  const children = new Map();
  for (const container of containers) {
    children.set(
      container.id,
      projects.filter((project) => project.parent_project_id === container.id),
    );
  }
  return { containers, children };
}

// --- Infraestructura idempotente ------------------------------------------

async function ensureGtdLabels(vikunja, log) {
  const labels = await vikunja.listLabels();
  const byTitle = new Map(
    labels.map((label) => [gtd.normalizeLabelTitle(label.title).toLowerCase(), label]),
  );
  for (const title of gtd.GTD_LABEL_TITLES) {
    if (!byTitle.get(title.toLowerCase())) {
      const label = await vikunja.createLabel({ title, hex_color: 'a78bfa' });
      byTitle.set(title.toLowerCase(), label);
      log(`Label creada en Vikunja: ${title} (#${label.id})`);
    }
  }
  return byTitle;
}

// --- Ciclo ----------------------------------------------------------------

async function runCycle({ config, pool, vikunja, webdav, dryRun = false, now = new Date(), log = () => {} }) {
  return withAdvisoryLock(pool, LOCK_KEY, async (db) => {
    const nowIso = now.toISOString();
    const run = {
      status: 'ok',
      vikunja_writes: 0,
      mindwtr_mutations: 0,
      detail: { actions: [], warnings: [] },
    };
    const warn = (message) => {
      run.detail.warnings.push(message);
      log(`⚠ ${message}`);
    };

    // 1-2. Estado del bridge + data.json
    const stateRow = (await db.query('SELECT * FROM bridge_state WHERE id = 1')).rows[0];
    if (!stateRow) throw new Error('bridge_state vacío: correr scripts/init-db.sh primero.');
    const deviceUuid = stateRow.device_uuid;

    const fetched = await webdav.get();
    const etag = fetched.etag;
    const data = model.parseData(fetched.body);

    // 3. Subtree ANYTYPE
    const projects = await vikunja.listProjects();
    const root = findAnytypeRoot(projects, config.root_project_title);
    const { containers, children } = buildSubtree(projects, root);

    // 4. Mapas
    const areaRows = (await db.query('SELECT * FROM area_map')).rows;
    const projectRows = (await db.query('SELECT * FROM project_map')).rows;
    const taskRows = (await db.query('SELECT * FROM task_map')).rows;
    const fieldRows = (await db.query('SELECT * FROM task_field_state')).rows;

    const areaByVikunja = new Map(areaRows.map((row) => [Number(row.vikunja_project_id), row]));
    const projectByVikunja = new Map(projectRows.map((row) => [Number(row.vikunja_project_id), row]));
    const mappingByVikunja = new Map(taskRows.map((row) => [Number(row.vikunja_task_id), row]));
    const fieldState = new Map();
    for (const row of fieldRows) {
      fieldState.set(`${row.vikunja_task_id}:${row.field_name}`, row);
    }

    // 5a. Labels (en dry-run no se crean las GTD, solo se leen las existentes).
    const labelByTitle = dryRun
      ? new Map((await vikunja.listLabels()).map((label) => [gtd.normalizeLabelTitle(label.title).toLowerCase(), label]))
      : await ensureGtdLabels(vikunja, log);

    // 5b. Estructura del subtree: project_id de Vikunja → contenedor/proyecto.
    // «00 · Sin proyecto» y el propio contenedor mandan la tarea al área.
    const subtreeEntry = new Map();
    const scopedProjectIds = new Set();
    for (const container of containers) {
      scopedProjectIds.add(container.id);
      subtreeEntry.set(container.id, { container, project: null });
      for (const project of children.get(container.id) ?? []) {
        scopedProjectIds.add(project.id);
        const isNoProject = project.title === config.no_project_title;
        subtreeEntry.set(project.id, { container, project: isNoProject ? null : project });
      }
    }

    // Resolución perezosa: crea el área/proyecto espejo SOLO cuando una tarea
    // lo necesita de verdad (crucial para el modo piloto). Las inserciones en
    // BD quedan pendientes hasta confirmar el PUT.
    const pendingAreaInserts = [];
    const pendingProjectInserts = [];
    let mindwtrMutated = false;

    const areaFor = (container) => {
      const existing = areaByVikunja.get(container.id);
      if (existing) return existing.mindwtr_area_id;
      if (dryRun) return `<area:${container.title}>`;
      const area = model.ensureArea(data, { name: container.title }, deviceUuid, nowIso);
      const row = { vikunja_project_id: container.id, mindwtr_area_id: area.id, display_name: container.title };
      areaByVikunja.set(container.id, row);
      pendingAreaInserts.push(row);
      mindwtrMutated = true;
      run.detail.actions.push({ type: 'create_area', name: container.title });
      return area.id;
    };

    const destinationFor = (vikunjaProjectId) => {
      const entry = subtreeEntry.get(vikunjaProjectId);
      if (!entry) return { projectId: null, areaId: null };
      if (!entry.project) {
        return { projectId: null, areaId: areaFor(entry.container) };
      }
      const existing = projectByVikunja.get(entry.project.id);
      if (existing) return { projectId: existing.mindwtr_project_id, areaId: null };
      if (dryRun) return { projectId: `<project:${entry.project.title}>`, areaId: null };
      const areaId = areaFor(entry.container);
      const mirror = model.ensureProject(data, { title: entry.project.title, areaId }, deviceUuid, nowIso);
      const row = {
        vikunja_project_id: entry.project.id,
        mindwtr_project_id: mirror.id,
        area_vikunja_project_id: entry.container.id,
        display_name: entry.project.title,
      };
      projectByVikunja.set(entry.project.id, row);
      pendingProjectInserts.push(row);
      mindwtrMutated = true;
      run.detail.actions.push({ type: 'create_project', name: entry.project.title, area: entry.container.title });
      return { projectId: mirror.id, areaId: null };
    };

    // 3b. Tareas del subtree + mapeadas ausentes (borradas o movidas fuera).
    const vikunjaTasks = new Map();
    for (const projectId of scopedProjectIds) {
      const tasks = await vikunja.listProjectTasks(projectId);
      for (const task of tasks) {
        vikunjaTasks.set(task.id, task);
      }
    }
    for (const row of taskRows) {
      const id = Number(row.vikunja_task_id);
      if (!vikunjaTasks.has(id) && row.state !== 'dismissed') {
        const task = await vikunja.getTask(id);
        vikunjaTasks.set(id, task); // null = borrada en Vikunja
      }
    }

    const mirrorById = new Map(data.tasks.map((task) => [task.id, task]));
    const pilotFilter = new Set((config.pilot_task_ids ?? []).map(Number));

    // 6. Plan por tarea.
    const vikunjaWriteQueue = [];  // {task, changes}
    const labelOps = [];           // {taskId, add: [title], remove: [title]}
    const mindwtrPatchQueue = [];  // {mirror, patch}
    const dbUpserts = [];          // fns(client) tras confirmar el PUT
    const commonRecords = [];      // {taskId, field, common, origin, persist}

    for (const [vikunjaTaskId, task] of vikunjaTasks) {
      const mapping = mappingByVikunja.get(vikunjaTaskId) ?? null;

      // Borrada en Vikunja o fuera del subtree → retirar espejo.
      const inScope = task && scopedProjectIds.has(task.project_id);
      if (mapping && (!task || !inScope)) {
        if (mapping.state === 'active') {
          const mirror = mirrorById.get(mapping.mindwtr_task_id);
          run.detail.actions.push({ type: 'retire_mirror', vikunja_task_id: vikunjaTaskId, reason: task ? 'out_of_scope' : 'deleted' });
          if (!dryRun && mirror && !model.isTombstoned(mirror)) {
            if (model.archiveTask(mirror, deviceUuid, nowIso)) {
              mindwtrMutated = true;
              run.mindwtr_mutations += 1;
            }
          }
          dbUpserts.push(async (client) => {
            await client.query(
              "UPDATE task_map SET state = 'retired', updated_at = now() WHERE vikunja_task_id = $1",
              [vikunjaTaskId],
            );
          });
        }
        continue;
      }
      if (!task) continue;

      // Espejo con tombstone local → dismissed, no tocar Vikunja jamás.
      if (mapping) {
        const mirror = mirrorById.get(mapping.mindwtr_task_id);
        const gone = !mirror || model.isTombstoned(mirror);
        if (gone && mapping.state !== 'dismissed') {
          run.detail.actions.push({ type: 'dismiss', vikunja_task_id: vikunjaTaskId, title: task.title });
          if (!mirror) warn(`Espejo ${mapping.mindwtr_task_id} desapareció sin tombstone (tarea ${vikunjaTaskId}).`);
          dbUpserts.push(async (client) => {
            await client.query(
              "UPDATE task_map SET state = 'dismissed', updated_at = now() WHERE vikunja_task_id = $1",
              [vikunjaTaskId],
            );
          });
          continue;
        }
        if (mapping.state === 'dismissed') continue;
      }

      // Sin mapeo → candidata a espejo nuevo (solo pendientes; respeta piloto).
      if (!mapping) {
        if (task.done) continue;
        if (pilotFilter.size > 0 && !pilotFilter.has(vikunjaTaskId)) continue;
        const destination = destinationFor(task.project_id);
        const { snapshot: vikunjaSnap, ambiguousGtd } = vikunjaLogicalSnapshot(task, {
          timezone: config.timezone,
          destination,
        });
        if (ambiguousGtd) {
          warn(`Tarea ${vikunjaTaskId} («${task.title}») tiene varias labels GTD; se usa la de mayor precedencia.`);
        }
        run.detail.actions.push({
          type: 'create_mirror',
          vikunja_task_id: vikunjaTaskId,
          title: vikunjaSnap.title,
          status: vikunjaSnap.gtd_status ?? 'inbox',
          project: vikunjaSnap.project,
          area: vikunjaSnap.area,
        });
        if (!dryRun) {
          const mirror = model.createMirrorTask(data, {
            title: vikunjaSnap.title,
            status: vikunjaSnap.gtd_status ?? 'inbox',
            priority: vikunjaSnap.priority,
            dueDate: vikunjaSnap.due_date,
            startTime: vikunjaSnap.start_time,
            projectId: destination.projectId,
            areaId: destination.areaId,
            isFocusedToday: config.enable_focus ? vikunjaSnap.focus : false,
            contexts: vikunjaSnap.contexts,
            tags: vikunjaSnap.tags,
          }, deviceUuid, nowIso);
          mindwtrMutated = true;
          run.mindwtr_mutations += 1;
          dbUpserts.push(async (client) => {
            await client.query(
              'INSERT INTO task_map (vikunja_task_id, mindwtr_task_id) VALUES ($1, $2)',
              [vikunjaTaskId, mirror.id],
            );
            for (const [field, value] of Object.entries(vikunjaSnap)) {
              await client.query(
                `INSERT INTO task_field_state
                   (vikunja_task_id, field_name, last_vikunja_value, last_mindwtr_value, last_common_value, last_origin)
                 VALUES ($1, $2, $3::jsonb, $3::jsonb, $3::jsonb, 'bootstrap')`,
                [vikunjaTaskId, field, JSON.stringify(value ?? null)],
              );
            }
          });
        }
        continue;
      }

      const mirror = mirrorById.get(mapping.mindwtr_task_id);
      const destination = destinationFor(task.project_id);
      const { snapshot: vikunjaSnap, ambiguousGtd } = vikunjaLogicalSnapshot(task, {
        timezone: config.timezone,
        destination,
      });
      if (ambiguousGtd) {
        warn(`Tarea ${vikunjaTaskId} («${task.title}») tiene varias labels GTD; se usa la de mayor precedencia.`);
      }

      // Resurrección: retirada pero reabierta en Vikunja.
      if (mapping.state === 'retired') {
        if (!task.done) {
          run.detail.actions.push({ type: 'resurrect_mirror', vikunja_task_id: vikunjaTaskId, title: task.title });
          if (!dryRun && mirror) {
            model.applyTaskPatch(mirror, { done: false, reopen_status: vikunjaSnap.gtd_status ?? 'next' }, deviceUuid, nowIso);
            mindwtrMutated = true;
            run.mindwtr_mutations += 1;
            dbUpserts.push(async (client) => {
              await client.query(
                "UPDATE task_map SET state = 'active', updated_at = now() WHERE vikunja_task_id = $1",
                [vikunjaTaskId],
              );
            });
          }
        }
        continue;
      }

      if (!mirror) continue; // defensa; el caso real ya se despachó arriba

      const mindwtrSnap = model.taskSnapshot(mirror, snapshotHelpers);

      // Retiro en dos pasos: done convergido en ambos lados → archivar.
      if (vikunjaSnap.done && mindwtrSnap.done) {
        run.detail.actions.push({ type: 'archive_mirror', vikunja_task_id: vikunjaTaskId, title: task.title });
        if (!dryRun) {
          if (model.archiveTask(mirror, deviceUuid, nowIso)) {
            mindwtrMutated = true;
            run.mindwtr_mutations += 1;
          }
          dbUpserts.push(async (client) => {
            await client.query(
              "UPDATE task_map SET state = 'retired', updated_at = now() WHERE vikunja_task_id = $1",
              [vikunjaTaskId],
            );
          });
        }
        continue;
      }

      // Three-way merge campo a campo.
      const patch = {};
      const vikunjaChanges = {};
      const taskLabelOps = { taskId: vikunjaTaskId, add: [], remove: [] };

      for (const [field, policy] of Object.entries(FIELD_POLICIES)) {
        if (field === 'focus' && !config.enable_focus) continue;
        const prior = fieldState.get(`${vikunjaTaskId}:${field}`);
        const vikunjaValue = vikunjaSnap[field] ?? null;
        const mindwtrValue = mindwtrSnap[field] ?? null;

        // done en tareas recurrentes de Vikunja: solo V→M (paridad con atvk).
        let direction = policy.direction;
        if (field === 'done' && Number(task.repeat_after ?? 0) > 0) {
          direction = 'vikunja_to_mindwtr';
        }

        let decision;
        if (policy.revert) {
          decision = equalValue(vikunjaValue, mindwtrValue)
            ? { action: 'accept_common', value: vikunjaValue }
            : { action: 'write_mindwtr', reason: 'revert_to_vikunja' };
        } else {
          decision = decideFieldSync({
            vikunjaValue,
            mindwtrValue,
            lastCommonValue: prior ? prior.last_common_value : null,
            hasLastCommon: Boolean(prior),
            direction,
            conflictPolicy: policy.conflict,
          });
        }

        if (decision.action === 'accept_common') {
          commonRecords.push({ taskId: vikunjaTaskId, field, common: vikunjaValue, origin: 'reconcile', persist: 'always' });
          continue;
        }
        if (decision.action === 'noop') continue;
        if (decision.action === 'conflict') {
          run.status = 'partial';
          run.detail.actions.push({ type: 'conflict', vikunja_task_id: vikunjaTaskId, field });
          dbUpserts.push(async (client) => {
            await client.query(
              'INSERT INTO sync_error (vikunja_task_id, field_name, message) VALUES ($1, $2, $3)',
              [vikunjaTaskId, field, `Conflicto simultáneo en ${field}`],
            );
          });
          continue;
        }

        if (decision.action === 'write_mindwtr') {
          patch[field] = vikunjaValue;
          if (field === 'done' && !vikunjaValue) patch.reopen_status = vikunjaSnap.gtd_status ?? 'next';
          commonRecords.push({ taskId: vikunjaTaskId, field, common: vikunjaValue, origin: 'vikunja', persist: 'on_put' });
          run.detail.actions.push({ type: 'update_mindwtr', vikunja_task_id: vikunjaTaskId, field, value: vikunjaValue });
          continue;
        }

        // write_vikunja
        commonRecords.push({
          taskId: vikunjaTaskId,
          field,
          common: mindwtrValue,
          origin: 'mindwtr',
          persist: policy.via === 'labels' ? 'on_label_write' : 'on_task_update',
        });
        run.detail.actions.push({ type: 'update_vikunja', vikunja_task_id: vikunjaTaskId, field, value: mindwtrValue });
        switch (field) {
          case 'done':
            vikunjaChanges.done = Boolean(mindwtrValue);
            break;
          case 'priority':
            vikunjaChanges.priority = gtd.mindwtrPriorityToVikunja(mindwtrValue);
            break;
          case 'due_date':
            vikunjaChanges.due_date = mindwtrValue
              ? gtd.composeVikunjaDate(mindwtrValue, task.due_date, config.timezone, config.default_due_time)
              : VIKUNJA_ZERO_DATE;
            break;
          case 'start_time':
            vikunjaChanges.start_date = mindwtrValue
              ? gtd.composeVikunjaDate(mindwtrValue, task.start_date, config.timezone, config.default_due_time)
              : VIKUNJA_ZERO_DATE;
            break;
          case 'focus':
            vikunjaChanges.is_favorite = Boolean(mindwtrValue);
            break;
          case 'gtd_status': {
            const desired = mindwtrValue ? gtd.gtdLabelForStatus(mindwtrValue) : null;
            const current = gtd.partitionLabels(task.labels ?? []).gtd;
            for (const title of current) {
              if (title !== desired) taskLabelOps.remove.push(title);
            }
            if (desired && !current.includes(desired)) taskLabelOps.add.push(desired);
            break;
          }
          case 'contexts':
          case 'tags': {
            const partition = gtd.partitionLabels(task.labels ?? []);
            const current = new Set(field === 'contexts' ? partition.contexts : partition.tags);
            const desired = new Set(mindwtrValue ?? []);
            for (const title of current) {
              if (!desired.has(title)) taskLabelOps.remove.push(title);
            }
            for (const title of desired) {
              if (!current.has(title)) taskLabelOps.add.push(title);
            }
            break;
          }
          default:
            warn(`Campo ${field} marcado write_vikunja sin ruta de escritura.`);
        }
      }

      if (Object.keys(vikunjaChanges).length > 0) {
        vikunjaWriteQueue.push({ task, changes: vikunjaChanges });
      }
      if (taskLabelOps.add.length > 0 || taskLabelOps.remove.length > 0) {
        labelOps.push(taskLabelOps);
      }
      if (Object.keys(patch).length > 0) {
        mindwtrPatchQueue.push({ mirror, patch });
      }
    }

    // 7. Dry-run: reporte y fin.
    if (dryRun) {
      await db.query(
        'INSERT INTO sync_run (finished_at, status, dry_run, detail) VALUES (now(), $1, true, $2::jsonb)',
        [run.status, JSON.stringify(run.detail)],
      );
      return { ok: true, dry_run: true, ...run };
    }

    // 8. Escrituras Vikunja. Confirmación separada por vía (update vs labels)
    // para que un fallo en una no persista el común de la otra.
    const confirmedTaskUpdates = new Set();
    const confirmedLabelWrites = new Set();
    for (const { task, changes } of vikunjaWriteQueue) {
      try {
        await vikunja.updateTask(task, changes);
        run.vikunja_writes += 1;
        confirmedTaskUpdates.add(task.id);
      } catch (error) {
        run.status = 'partial';
        warn(`updateTask ${task.id} falló: ${error.message}`);
        dbUpserts.push(async (client) => {
          await client.query(
            'INSERT INTO sync_error (vikunja_task_id, message) VALUES ($1, $2)',
            [task.id, `updateTask: ${error.message}`],
          );
        });
      }
    }
    for (const op of labelOps) {
      try {
        for (const title of op.remove) {
          const label = labelByTitle.get(gtd.normalizeLabelTitle(title).toLowerCase());
          if (label) await vikunja.removeLabel(op.taskId, label.id);
        }
        for (const title of op.add) {
          let label = labelByTitle.get(gtd.normalizeLabelTitle(title).toLowerCase());
          if (!label) {
            label = await vikunja.createLabel({ title });
            labelByTitle.set(gtd.normalizeLabelTitle(title).toLowerCase(), label);
          }
          await vikunja.addLabel(op.taskId, label.id);
        }
        run.vikunja_writes += 1;
        confirmedLabelWrites.add(op.taskId);
      } catch (error) {
        run.status = 'partial';
        warn(`labels de tarea ${op.taskId} fallaron: ${error.message}`);
        dbUpserts.push(async (client) => {
          await client.query(
            'INSERT INTO sync_error (vikunja_task_id, message) VALUES ($1, $2)',
            [op.taskId, `labels: ${error.message}`],
          );
        });
      }
    }

    // 9. Mutaciones Mindwtr en memoria.
    for (const { mirror, patch } of mindwtrPatchQueue) {
      if (model.applyTaskPatch(mirror, patch, deviceUuid, nowIso)) {
        mindwtrMutated = true;
        run.mindwtr_mutations += 1;
      }
    }

    // 10. PUT condicional.
    let putOk = true;
    if (mindwtrMutated) {
      const body = model.serializeData(data);
      const result = await webdav.putIfMatch(body, etag);
      if (result.conflict) {
        putOk = false;
        run.status = 'skipped_etag';
        warn('PUT 412: la app escribió data.json durante el ciclo; se reintenta en el siguiente.');
      } else {
        await db.query(
          'UPDATE bridge_state SET last_etag = $1, last_written_sha256 = $2, updated_at = now() WHERE id = 1',
          [result.etag, sha256(body)],
        );
      }
    }

    // 11. Persistencia selectiva.
    if (putOk) {
      for (const row of pendingAreaInserts) {
        await db.query(
          'INSERT INTO area_map (vikunja_project_id, mindwtr_area_id, display_name) VALUES ($1, $2, $3)',
          [row.vikunja_project_id, row.mindwtr_area_id, row.display_name],
        );
      }
      for (const row of pendingProjectInserts) {
        await db.query(
          'INSERT INTO project_map (vikunja_project_id, mindwtr_project_id, area_vikunja_project_id, display_name) VALUES ($1, $2, $3, $4)',
          [row.vikunja_project_id, row.mindwtr_project_id, row.area_vikunja_project_id, row.display_name],
        );
      }
      for (const upsert of dbUpserts) {
        await upsert(db);
      }
    }
    for (const record of commonRecords) {
      const persist = record.persist === 'always'
        || (record.persist === 'on_put' && putOk)
        || (record.persist === 'on_task_update' && confirmedTaskUpdates.has(record.taskId))
        || (record.persist === 'on_label_write' && confirmedLabelWrites.has(record.taskId));
      if (!persist) continue;
      await db.query(
        `INSERT INTO task_field_state
           (vikunja_task_id, field_name, last_vikunja_value, last_mindwtr_value, last_common_value, last_origin, updated_at)
         VALUES ($1, $2, $3::jsonb, $3::jsonb, $3::jsonb, $4, now())
         ON CONFLICT (vikunja_task_id, field_name) DO UPDATE SET
           last_vikunja_value = EXCLUDED.last_vikunja_value,
           last_mindwtr_value = EXCLUDED.last_mindwtr_value,
           last_common_value = EXCLUDED.last_common_value,
           last_origin = EXCLUDED.last_origin,
           updated_at = now()`,
        [record.taskId, record.field, JSON.stringify(record.common ?? null), record.origin],
      );
    }

    await db.query(
      'INSERT INTO sync_run (finished_at, status, dry_run, vikunja_writes, mindwtr_mutations, detail) VALUES (now(), $1, false, $2, $3, $4::jsonb)',
      [run.status, run.vikunja_writes, run.mindwtr_mutations, JSON.stringify(run.detail)],
    );

    return { ok: true, dry_run: false, put_ok: putOk, ...run };
  });
}

module.exports = {
  FIELD_POLICIES,
  VIKUNJA_ZERO_DATE,
  buildSubtree,
  findAnytypeRoot,
  runCycle,
  vikunjaLogicalSnapshot,
};
