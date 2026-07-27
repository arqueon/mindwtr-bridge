'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCycle } = require('../src/reconcile');
const { provenanceMarker, projectProvenanceMarker } = require('../src/capture');
const model = require('../src/mindwtr-model');
const {
  BASE_CONFIG, makeFakeAnytype, makeFakeAtvkDb, makeFakeDb, makeFakeVikunja, makeFakeWebdav,
} = require('./helpers');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'data.json'), 'utf8');
const NOW = new Date('2026-07-27T12:00:00.000Z');
const OLD = '2026-07-27T10:00:00Z'; // 120 min antes: pasa la gracia
const RECENT = '2026-07-27T11:58:00Z'; // 2 min antes: no pasa la gracia

const SPACE = 'space-A';
const CAPTURE_CONFIG = { ...BASE_CONFIG, enable_capture: true, capture_grace_minutes: 5 };

const PROJECTS = [
  { id: 100, title: 'ANYTYPE', parent_project_id: 0 },
  { id: 101, title: 'Our Space 🔥', parent_project_id: 100 },
  { id: 102, title: '00 · Sin proyecto', parent_project_id: 101 },
  { id: 103, title: 'Proyecto X', parent_project_id: 101 },
];

const ATVK_CHANNELS = [{
  anytype_space_id: SPACE,
  channel_name: 'Our Space 🔥',
  task_type_key: 'task',
  due_property_key: 'due_date',
  project_property_key: 'linked_projects',
  tags_property_key: 'tag',
  vikunja_project_id: 101,
  no_project_vikunja_id: 102,
}];

const ATVK_PROJECTS = [
  { anytype_space_id: SPACE, anytype_project_id: 'anyproj-X', vikunja_project_id: 103 },
];

// Puente ya convergido: área y proyecto espejo existentes.
const BRIDGE_SEED = {
  area_map: [{ vikunja_project_id: 101, mindwtr_area_id: 'area-os', display_name: 'Our Space 🔥' }],
  project_map: [{ vikunja_project_id: 103, mindwtr_project_id: 'proj-x', area_vikunja_project_id: 101, display_name: 'Proyecto X' }],
};

function dataWith(extraTasks = [], extraProjects = []) {
  const data = model.parseData(FIXTURE);
  data.areas.push({ id: 'area-os', name: 'Our Space 🔥', order: 0, createdAt: OLD, updatedAt: OLD, rev: 1 });
  data.projects.push({
    id: 'proj-x', title: 'Proyecto X', status: 'active', color: '#94a3b8', order: 5,
    tagIds: [], areaId: 'area-os', createdAt: OLD, updatedAt: OLD, rev: 1,
  });
  data.tasks.push(...extraTasks);
  data.projects.push(...extraProjects);
  return model.serializeData(data);
}

function makeWorld({ data, tasksByProject = { 101: [], 102: [], 103: [] }, atvk = {}, seed = {} }) {
  const db = makeFakeDb({ ...BRIDGE_SEED, ...seed });
  const vikunja = makeFakeVikunja({ projects: PROJECTS, tasksByProject, labels: [{ id: 9, title: 'GTD: Next' }] });
  const webdav = makeFakeWebdav(data);
  const anytype = makeFakeAnytype();
  const atvkDb = makeFakeAtvkDb({ channels: ATVK_CHANNELS, taskRows: atvk.taskRows ?? [], projectRows: ATVK_PROJECTS });
  return { db, vikunja, webdav, anytype, atvkDb };
}

async function cycle(world, { dryRun = false } = {}) {
  return runCycle({
    config: CAPTURE_CONFIG,
    pool: world.db.pool,
    vikunja: world.vikunja,
    webdav: world.webdav,
    anytype: world.anytype,
    atvkPool: world.atvkDb,
    dryRun,
    now: NOW,
  });
}

test('captura mindwtr: tarea en proyecto espejo nace en Anytype con Linked Project y fecha', async () => {
  const data = dataWith([{
    id: 'cap-t1', title: 'Capturada desde Mindwtr', status: 'next', projectId: 'proj-x',
    dueDate: '2026-08-02', contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
  }]);
  const world = makeWorld({ data });
  const result = await cycle(world);

  const created = world.anytype.calls.createObject;
  assert.equal(created.length, 1);
  assert.equal(created[0].spaceId, SPACE);
  assert.equal(created[0].payload.type_key, 'task');
  assert.equal(created[0].payload.name, 'Capturada desde Mindwtr');
  const linked = created[0].payload.properties.find((p) => p.key === 'linked_projects');
  assert.deepEqual(linked.objects, ['anyproj-X']);
  assert.ok(created[0].payload.properties.some((p) => p.key === 'due_date' && p.date));

  const row = world.db.state.capture_map[0];
  assert.equal(row.state, 'pending');
  assert.equal(row.origin, 'mindwtr');
  assert.equal(row.anytype_object_id, created[0].id);
  assert.ok(result.detail.actions.some((a) => a.type === 'capture_create'));

  // Las tareas personales del fixture no se capturan.
  assert.equal(world.db.state.capture_map.length, 1);
});

test('captura mindwtr NO se repite en el siguiente ciclo (capture_map la conoce)', async () => {
  const data = dataWith([{
    id: 'cap-t1', title: 'Capturada', status: 'next', projectId: 'proj-x',
    contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
  }]);
  const world = makeWorld({
    data,
    seed: {
      ...BRIDGE_SEED,
      capture_map: [{
        id: 1, origin: 'mindwtr', kind: 'task', mindwtr_id: 'cap-t1', vikunja_id: null,
        anytype_space_id: SPACE, anytype_object_id: 'obj-ya-creado', state: 'pending', created_at: OLD,
      }],
    },
  });
  await cycle(world);
  assert.equal(world.anytype.calls.createObject.length, 0);
});

test('adopción mindwtr: la tarea Vikunja creada por atvk se enlaza al espejo original', async () => {
  const data = dataWith([{
    id: 'cap-t1', title: 'Capturada', status: 'next', projectId: 'proj-x',
    contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
  }]);
  const world = makeWorld({
    data,
    tasksByProject: {
      101: [], 102: [],
      103: [{ id: 601, project_id: 103, title: 'Capturada', done: false, labels: [], created: OLD }],
    },
    atvk: { taskRows: [{ anytype_space_id: SPACE, anytype_task_id: 'obj-ya-creado', vikunja_task_id: 601 }] },
    seed: {
      ...BRIDGE_SEED,
      capture_map: [{
        id: 1, origin: 'mindwtr', kind: 'task', mindwtr_id: 'cap-t1', vikunja_id: null,
        anytype_space_id: SPACE, anytype_object_id: 'obj-ya-creado', state: 'pending', created_at: OLD,
      }],
    },
  });
  const result = await cycle(world);

  // Sin espejo duplicado: el mapping usa el uuid ORIGINAL.
  const mapping = world.db.state.task_map.find((row) => Number(row.vikunja_task_id) === 601);
  assert.equal(mapping.mindwtr_task_id, 'cap-t1');
  assert.equal(world.db.state.capture_map[0].state, 'adopted');
  assert.equal(world.db.state.capture_map[0].vikunja_id, 601);
  assert.ok(result.detail.actions.some((a) => a.type === 'capture_adopt' && a.kind === 'task'));
  assert.equal(result.detail.actions.some((a) => a.type === 'create_mirror' && a.vikunja_task_id === 601), false);
});

test('captura vikunja: tarea vieja sin atvk nace en Anytype, tags espejados y marcador válido', async () => {
  const world = makeWorld({
    data: dataWith(),
    tasksByProject: {
      101: [], 102: [],
      103: [{
        id: 777, project_id: 103, title: 'Nacida en Vikunja', done: false, created: OLD,
        description: 'contexto original',
        labels: [{ id: 9, title: 'GTD: Next' }],
      }],
    },
  });
  const result = await cycle(world);

  const created = world.anytype.calls.createObject.find((c) => c.payload.name === 'Nacida en Vikunja');
  assert.ok(created);
  assert.equal(created.payload.body, 'contexto original');

  // Tags espejo de las labels (evita que la siembra de atvk las borre).
  const tagged = world.anytype.calls.updateObject.find((c) => c.objectId === created.id);
  assert.ok(tagged.patch.properties[0].multi_select.length === 1);
  assert.ok(world.anytype.calls.createTag.some((c) => c.tag.name === 'GTD: Next'));

  // Marcador en la descripción de la tarea Vikunja, formato exacto de atvk.
  const update = world.vikunja.calls.updateTask.find((c) => c.taskId === 777);
  assert.ok(update.changes.description.includes(provenanceMarker(SPACE, created.id)));

  const row = world.db.state.capture_map.find((r) => Number(r.vikunja_id) === 777);
  assert.equal(row.state, 'pending');
  assert.equal(row.origin, 'vikunja');
  void result;
});

test('gracia: una tarea Vikunja recién creada NO se captura todavía', async () => {
  const world = makeWorld({
    data: dataWith(),
    tasksByProject: {
      101: [], 102: [],
      103: [{ id: 778, project_id: 103, title: 'Recién nacida', done: false, created: RECENT, labels: [] }],
    },
  });
  await cycle(world);
  assert.equal(world.anytype.calls.createObject.length, 0);
  assert.equal(world.db.state.capture_map.length, 0);
});

test('captura vikunja de proyecto: objeto Project + marcador atvk-project en el proyecto Vikunja', async () => {
  const projectsWithNew = [...PROJECTS, { id: 105, title: 'Proyecto nacido en Vikunja', parent_project_id: 101, created: OLD }];
  const db = makeFakeDb(BRIDGE_SEED);
  const vikunja = makeFakeVikunja({
    projects: projectsWithNew,
    tasksByProject: { 101: [], 102: [], 103: [], 105: [] },
    labels: [],
  });
  const world = {
    db,
    vikunja,
    webdav: makeFakeWebdav(dataWith()),
    anytype: makeFakeAnytype(),
    atvkDb: makeFakeAtvkDb({ channels: ATVK_CHANNELS, taskRows: [], projectRows: ATVK_PROJECTS }),
  };
  await cycle(world);

  const created = world.anytype.calls.createObject.find((c) => c.payload.name === 'Proyecto nacido en Vikunja');
  assert.ok(created);
  assert.equal(created.payload.type_key, 'project');
  const update = world.vikunja.calls.updateProject.find((c) => c.projectId === 105);
  assert.ok(update.project.description.includes(projectProvenanceMarker(SPACE, created.id)));
});

test('dry-run: la captura solo planifica, sin llamadas de escritura', async () => {
  const data = dataWith([{
    id: 'cap-t1', title: 'Capturada', status: 'next', projectId: 'proj-x',
    contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
  }]);
  const world = makeWorld({ data });
  const result = await cycle(world, { dryRun: true });
  assert.ok(result.detail.actions.some((a) => a.type === 'capture_create'));
  assert.equal(world.anytype.calls.createObject.length, 0);
  assert.equal(world.db.state.capture_map.length, 0);
});
