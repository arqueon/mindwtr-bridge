'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCycle } = require('../src/reconcile');
const model = require('../src/mindwtr-model');
const { BASE_CONFIG, makeFakeDb, makeFakeVikunja, makeFakeWebdav } = require('./helpers');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'data.json'), 'utf8');
const NOW = new Date('2026-07-27T12:00:00.000Z');

const PROJECTS = [
  { id: 100, title: 'ANYTYPE', parent_project_id: 0 },
  { id: 101, title: 'Our Space 🔥', parent_project_id: 100 },
  { id: 102, title: '00 · Sin proyecto', parent_project_id: 101 },
  { id: 103, title: 'Proyecto X', parent_project_id: 101 },
  { id: 900, title: 'Personal Vikunja', parent_project_id: 0 },
];

const LABELS = [
  { id: 9, title: 'GTD: Next' },
  { id: 8, title: '@work' },
  { id: 7, title: 'deep' },
];

function baseTasks() {
  return {
    101: [],
    102: [
      { id: 501, project_id: 102, title: 'Tarea suelta', done: false, labels: [], priority: 0 },
      { id: 503, project_id: 102, title: 'Ya hecha', done: true, labels: [] },
      { id: 504, project_id: 102, title: 'Con fecha sin label', done: false, labels: [], due_date: '2026-08-01T15:00:00Z' },
    ],
    103: [
      {
        id: 502,
        project_id: 103,
        title: 'Tarea de proyecto',
        description: '<p>Plan útil</p><p><strong>Origen Anytype</strong></p><p><a href="https://object.any.coop/invite/?inviteId=secreto#invite_key">Abrir</a></p><!-- atvk:v6 -->',
        done: false,
        priority: 3,
        due_date: '2026-07-28T15:00:00Z',
        is_favorite: true,
        labels: [
          { id: 9, title: 'GTD: Next' },
          { id: 8, title: '@work' },
          { id: 7, title: 'deep' },
        ],
      },
    ],
    900: [
      { id: 901, project_id: 900, title: 'Vikunja personal', done: false, labels: [] },
    ],
  };
}

function makeWorld({ data = FIXTURE, tasks = baseTasks(), seed = {}, conflictOnPut = false } = {}) {
  const db = makeFakeDb(seed);
  const vikunja = makeFakeVikunja({ projects: PROJECTS, tasksByProject: tasks, labels: LABELS.map((l) => ({ ...l })) });
  const webdav = makeFakeWebdav(data, { conflictOnPut });
  return { db, vikunja, webdav };
}

async function cycle(world, { dryRun = false, config = {} } = {}) {
  return runCycle({
    config: { ...BASE_CONFIG, ...config },
    pool: world.db.pool,
    vikunja: world.vikunja,
    webdav: world.webdav,
    dryRun,
    now: NOW,
  });
}

test('dry-run: plan de espejos sin escritura alguna', async () => {
  const world = makeWorld();
  const result = await cycle(world, { dryRun: true });

  assert.equal(result.dry_run, true);
  const creates = result.detail.actions.filter((action) => action.type === 'create_mirror');
  assert.deepEqual(creates.map((action) => action.vikunja_task_id).sort(), [501, 502, 504]);
  // Regla GTD de la app: inbox con fecha nace ya como next.
  assert.equal(creates.find((action) => action.vikunja_task_id === 504).status, 'next');
  assert.equal(creates.find((action) => action.vikunja_task_id === 501).status, 'inbox');
  // La hecha (503) y la de fuera del subtree (901) no aparecen.
  assert.equal(result.detail.actions.some((a) => a.vikunja_task_id === 503), false);
  assert.equal(result.detail.actions.some((a) => a.vikunja_task_id === 901), false);

  assert.equal(world.webdav.record.puts.length, 0);
  assert.equal(world.vikunja.calls.updateTask.length, 0);
  assert.equal(world.vikunja.calls.createLabel.length, 0);
  assert.equal(world.db.state.task_map.length, 0);
});

test('ciclo real: crea espejos, área y proyecto; preserva lo personal', async () => {
  const world = makeWorld();
  const result = await cycle(world);

  assert.equal(result.put_ok, true);
  assert.equal(world.webdav.record.puts.length, 1);

  const written = model.parseData(world.webdav.record.puts[0].body);
  const before = model.parseData(FIXTURE);

  // Las tareas personales quedan byte a byte iguales (incluye campo desconocido).
  for (const original of before.tasks) {
    assert.deepEqual(written.tasks.find((task) => task.id === original.id), original);
  }

  // Área por Space y proyecto espejo por proyecto Anytype.
  assert.equal(written.areas.length, 1);
  assert.equal(written.areas[0].name, 'Our Space 🔥');
  const mirrorProject = written.projects.find((project) => project.title === 'Proyecto X');
  assert.ok(mirrorProject);
  assert.equal(mirrorProject.areaId, written.areas[0].id);

  // Espejo de tarea suelta: al área, sin proyecto, status inbox.
  const mapping501 = world.db.state.task_map.find((row) => row.vikunja_task_id === 501);
  const mirror501 = written.tasks.find((task) => task.id === mapping501.mindwtr_task_id);
  assert.equal(mirror501.areaId, written.areas[0].id);
  assert.equal(mirror501.projectId, undefined);
  assert.equal(mirror501.status, 'inbox');
  assert.equal(mirror501.rev, 1);

  // Espejo de tarea de proyecto: proyecto espejo, GTD Next, priority high,
  // contexto y tag particionados, focus.
  const mapping502 = world.db.state.task_map.find((row) => row.vikunja_task_id === 502);
  const mirror502 = written.tasks.find((task) => task.id === mapping502.mindwtr_task_id);
  assert.equal(mirror502.projectId, mirrorProject.id);
  assert.equal(mirror502.description, 'Plan útil');
  assert.equal(mirror502.status, 'next');
  assert.equal(mirror502.priority, 'high');
  assert.equal(mirror502.dueDate, '2026-07-28');
  assert.deepEqual(mirror502.contexts, ['@work']);
  assert.deepEqual(mirror502.tags, ['deep']);
  assert.equal(mirror502.isFocusedToday, true);

  // Ninguna escritura hacia Vikunja en el bootstrap.
  assert.equal(world.vikunja.calls.updateTask.length, 0);
  assert.equal(world.vikunja.calls.addLabel.length, 0);

  // Se sembraron field states.
  assert.ok(world.db.state.task_field_state.some(
    (row) => row.vikunja_task_id === 502 && row.field_name === 'gtd_status' && row.last_common_value === 'next',
  ));
});

test('labels GTD faltantes se crean en Vikunja (no en dry-run)', async () => {
  const world = makeWorld();
  await cycle(world);
  const created = world.vikunja.calls.createLabel.map((label) => label.title).sort();
  assert.deepEqual(created, ['GTD: Reference', 'GTD: Someday', 'GTD: Waiting']);
});

// Mundo con la tarea 502 ya espejada y convergida, para probar deltas.
async function convergedWorld(mutate) {
  const world = makeWorld();
  await cycle(world);
  const body = world.webdav.record.puts[0].body;
  const data = model.parseData(body);
  const mapping = world.db.state.task_map.find((row) => row.vikunja_task_id === 502);
  const mirror = data.tasks.find((task) => task.id === mapping.mindwtr_task_id);
  const convergedBody = mutate
    ? (mutate({ data, mirror }) ?? model.serializeData(data))
    : model.serializeData(data);
  const next = makeWorld({
    data: convergedBody,
    seed: {
      task_map: world.db.state.task_map,
      task_field_state: world.db.state.task_field_state,
      area_map: world.db.state.area_map,
      project_map: world.db.state.project_map,
    },
  });
  return { world: next, mapping, body: convergedBody };
}

test('cambio de status GTD en Mindwtr → add/remove de labels GTD en Vikunja', async () => {
  const { world } = await convergedWorld(({ data, mirror }) => {
    mirror.status = 'waiting';
    mirror.rev += 1;
    return model.serializeData(data);
  });
  const result = await cycle(world);

  assert.equal(result.status, 'ok');
  const removed = world.vikunja.calls.removeLabel.map((call) => call.labelId);
  assert.deepEqual(removed, [9]); // GTD: Next de la 502
  const added = world.vikunja.calls.createLabel.find((label) => label.title === 'GTD: Waiting');
  assert.ok(added, 'GTD: Waiting se crea si no existía');
  assert.ok(world.vikunja.calls.addLabel.some((call) => call.taskId === 502 && call.labelId === added.id));
  // La 504 (nacida next por fecha) empuja su GTD: Next de forma determinista.
  assert.ok(world.vikunja.calls.addLabel.some((call) => call.taskId === 504));
  // Solo se tocó el subconjunto GTD: @work y deep siguen intactos.
  assert.equal(world.vikunja.calls.removeLabel.some((call) => [8, 7].includes(call.labelId)), false);
});

test('done en Mindwtr → done en Vikunja; sin tocar título ni proyecto', async () => {
  const { world } = await convergedWorld(({ data, mirror }) => {
    mirror.status = 'done';
    mirror.completedAt = '2026-07-27T11:00:00.000Z';
    mirror.rev += 1;
    return model.serializeData(data);
  });
  await cycle(world);

  assert.equal(world.vikunja.calls.updateTask.length, 1);
  const { changes } = world.vikunja.calls.updateTask[0];
  assert.deepEqual(Object.keys(changes), ['done']);
  assert.equal(changes.done, true);
});

test('el bridge jamás escribe title/description/project_id hacia Vikunja', async () => {
  const { world } = await convergedWorld(({ data, mirror }) => {
    mirror.title = 'Título cambiado localmente';
    mirror.priority = 'urgent';
    mirror.rev += 1;
    return model.serializeData(data);
  });
  const result = await cycle(world);

  for (const call of world.vikunja.calls.updateTask) {
    assert.equal('title' in call.changes, false);
    assert.equal('description' in call.changes, false);
    assert.equal('project_id' in call.changes, false);
  }
  // priority sí viajó (urgent → 4).
  assert.ok(world.vikunja.calls.updateTask.some((call) => call.changes.priority === 4));
  // Y el título local se revirtió al de Vikunja en el data.json.
  assert.ok(result.detail.actions.some(
    (action) => action.type === 'update_mindwtr' && action.field === 'title',
  ));
  const written = model.parseData(world.webdav.record.puts.at(-1).body);
  const mapping = world.db.state.task_map.find((row) => row.vikunja_task_id === 502);
  assert.equal(
    written.tasks.find((task) => task.id === mapping.mindwtr_task_id).title,
    'Tarea de proyecto',
  );
});

test('description saneada se actualiza mientras siga administrada por el bridge', async () => {
  const { world, body } = await convergedWorld();
  const task = baseTasks()[103][0];
  task.description = '<p>Plan actualizado</p><p><strong>Origen Anytype</strong></p><p>anytype://secreto</p>';
  const updatedWorld = makeWorld({
    data: body,
    tasks: { ...baseTasks(), 103: [task] },
    seed: {
      task_map: world.db.state.task_map,
      task_field_state: world.db.state.task_field_state,
      area_map: world.db.state.area_map,
      project_map: world.db.state.project_map,
    },
  });
  const result = await cycle(updatedWorld);
  const written = model.parseData(updatedWorld.webdav.record.puts.at(-1).body);
  const mapping = updatedWorld.db.state.task_map.find((row) => row.vikunja_task_id === 502);
  const mirror = written.tasks.find((item) => item.id === mapping.mindwtr_task_id);

  assert.equal(mirror.description, 'Plan actualizado');
  const action = result.detail.actions.find((item) => item.field === 'description');
  assert.deepEqual(action, {
    type: 'update_mindwtr',
    vikunja_task_id: 502,
    field: 'description',
    content_changed: true,
  });
});

test('description local de Mindwtr se preserva aunque cambie Vikunja', async () => {
  const tasks = baseTasks();
  tasks[103][0].description = '<p>Plan actualizado</p><p><strong>Origen Anytype</strong></p>';
  const { world, body } = await convergedWorld(({ data, mirror }) => {
    mirror.description = 'Mi nota local privada';
    mirror.rev += 1;
    return model.serializeData(data);
  });
  const preservedWorld = makeWorld({
    data: body,
    tasks,
    seed: {
      task_map: world.db.state.task_map,
      task_field_state: world.db.state.task_field_state,
      area_map: world.db.state.area_map,
      project_map: world.db.state.project_map,
    },
  });
  const result = await cycle(preservedWorld);
  const written = preservedWorld.webdav.record.puts.length
    ? model.parseData(preservedWorld.webdav.record.puts.at(-1).body)
    : model.parseData((await preservedWorld.webdav.get()).body);
  const mapping = preservedWorld.db.state.task_map.find((row) => row.vikunja_task_id === 502);
  assert.equal(written.tasks.find((item) => item.id === mapping.mindwtr_task_id).description, 'Mi nota local privada');
  assert.ok(result.detail.actions.some(
    (item) => item.type === 'preserve_mindwtr_description' && item.vikunja_task_id === 502,
  ));

  // El checkpoint conserva el origen local también en ciclos posteriores.
  tasks[103][0].description = '<p>Plan tercero</p><p><strong>Origen Anytype</strong></p>';
  const nextWorld = makeWorld({
    data: model.serializeData(written),
    tasks,
    seed: {
      task_map: preservedWorld.db.state.task_map,
      task_field_state: preservedWorld.db.state.task_field_state,
      area_map: preservedWorld.db.state.area_map,
      project_map: preservedWorld.db.state.project_map,
    },
  });
  await cycle(nextWorld);
  const nextData = nextWorld.webdav.record.puts.length
    ? model.parseData(nextWorld.webdav.record.puts.at(-1).body)
    : model.parseData((await nextWorld.webdav.get()).body);
  assert.equal(nextData.tasks.find((item) => item.id === mapping.mindwtr_task_id).description, 'Mi nota local privada');
});

test('description vacía de un espejo existente se rellena de forma segura', async () => {
  const { world } = await convergedWorld(({ data, mirror }) => {
    delete mirror.description;
    mirror.rev += 1;
    return model.serializeData(data);
  });
  const result = await cycle(world);
  const written = model.parseData(world.webdav.record.puts.at(-1).body);
  const mapping = world.db.state.task_map.find((row) => row.vikunja_task_id === 502);
  assert.equal(written.tasks.find((item) => item.id === mapping.mindwtr_task_id).description, 'Plan útil');
  assert.ok(result.detail.actions.some(
    (item) => item.type === 'update_mindwtr' && item.field === 'description',
  ));
});

test('description ya convergida sin checkpoint se adopta como gestionada', async () => {
  const { world, body } = await convergedWorld();
  const recovered = makeWorld({
    data: body,
    seed: {
      task_map: world.db.state.task_map,
      task_field_state: world.db.state.task_field_state.filter(row => row.field_name !== 'description'),
      area_map: world.db.state.area_map,
      project_map: world.db.state.project_map,
    },
  });
  await cycle(recovered);
  const checkpoint = recovered.db.state.task_field_state.find(
    row => row.vikunja_task_id === 502 && row.field_name === 'description',
  );
  assert.equal(checkpoint.last_origin, 'vikunja_sanitized');
  assert.equal(checkpoint.last_common_value, 'Plan útil');
});

test('412 en el PUT aborta el lado Mindwtr sin persistir mapeos nuevos', async () => {
  const world = makeWorld({ conflictOnPut: true });
  const result = await cycle(world);

  assert.equal(result.status, 'skipped_etag');
  assert.equal(result.put_ok, false);
  assert.equal(world.db.state.task_map.length, 0);
  assert.equal(world.db.state.area_map.length, 0);
});

test('tombstone local → dismissed y sin escrituras a Vikunja', async () => {
  const { world, mapping } = await convergedWorld(({ data, mirror }) => {
    mirror.deletedAt = '2026-07-27T11:30:00.000Z';
    mirror.rev += 1;
    return model.serializeData(data);
  });
  const result = await cycle(world);

  const row = world.db.state.task_map.find((item) => item.vikunja_task_id === 502);
  assert.equal(row.state, 'dismissed');
  assert.equal(world.vikunja.calls.updateTask.length, 0);
  assert.equal(world.vikunja.calls.removeLabel.length, 0);
  assert.ok(result.detail.actions.some((action) => action.type === 'dismiss'));
  assert.ok(mapping.mindwtr_task_id);
});

test('done convergido en ambos lados → espejo archivado y mapeo retired', async () => {
  // Estado convergido + la tarea Vikunja marcada done → 1er ciclo propaga al
  // espejo; 2º ciclo (ambos done) archiva y retira.
  const { world: converged, body: convergedBody } = await convergedWorld();
  const doneTasks = baseTasks();
  doneTasks[103][0].done = true;
  const worldDone = makeWorld({
    data: convergedBody,
    tasks: doneTasks,
    seed: {
      task_map: converged.db.state.task_map,
      task_field_state: converged.db.state.task_field_state,
      area_map: converged.db.state.area_map,
      project_map: converged.db.state.project_map,
    },
  });
  const resultA = await cycle(worldDone);
  assert.ok(resultA.detail.actions.some(
    (action) => action.type === 'update_mindwtr' && action.field === 'done',
  ));

  // Segundo ciclo: ambos done → archive + retired.
  const worldArchive = makeWorld({
    data: worldDone.webdav.record.puts.at(-1).body,
    tasks: doneTasks,
    seed: {
      task_map: worldDone.db.state.task_map,
      task_field_state: worldDone.db.state.task_field_state,
      area_map: worldDone.db.state.area_map,
      project_map: worldDone.db.state.project_map,
    },
  });
  const resultB = await cycle(worldArchive);
  assert.ok(resultB.detail.actions.some((action) => action.type === 'archive_mirror'));
  const row = worldArchive.db.state.task_map.find((item) => item.vikunja_task_id === 502);
  assert.equal(row.state, 'retired');
  const written = model.parseData(worldArchive.webdav.record.puts.at(-1).body);
  const mirror = written.tasks.find((task) => task.id === row.mindwtr_task_id);
  assert.equal(mirror.status, 'archived');
});

test('modo piloto: solo la tarea del filtro se espeja', async () => {
  const world = makeWorld();
  const result = await cycle(world, { config: { pilot_task_ids: [502] } });

  const creates = result.detail.actions.filter((action) => action.type === 'create_mirror');
  assert.deepEqual(creates.map((action) => action.vikunja_task_id), [502]);
  // Y no se creó el área hasta que una tarea la necesitó de verdad: 502 vive
  // en Proyecto X, así que área + proyecto existen, pero solo esos.
  assert.equal(world.db.state.area_map.length, 1);
  assert.equal(world.db.state.project_map.length, 1);
});
