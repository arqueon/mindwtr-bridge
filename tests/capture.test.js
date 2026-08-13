'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCycle } = require('../src/reconcile');
const { captureMarker } = require('../src/capture');
const model = require('../src/mindwtr-model');
const {
  BASE_CONFIG, makeFakeAnytype, makeFakeAtvkDb, makeFakeDb, makeFakeVikunja, makeFakeWebdav,
} = require('./helpers');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'data.json'), 'utf8');
const NOW = new Date('2026-08-12T12:00:00.000Z');
const OLD = '2026-08-12T10:00:00Z';
const TASK_ID = '10000000-0000-4000-8000-000000000001';
const PROJECT_ID = '20000000-0000-4000-8000-000000000002';

const CONFIG = { ...BASE_CONFIG, enable_capture: true };
const PROJECTS = [
  { id: 100, title: 'ANYTYPE', parent_project_id: 0 },
  { id: 101, title: 'Our Space 🔥', parent_project_id: 100 },
  { id: 102, title: '00 · Sin proyecto', parent_project_id: 101 },
  { id: 103, title: 'Proyecto X', parent_project_id: 101 },
];
const BRIDGE_SEED = {
  area_map: [{ vikunja_project_id: 101, mindwtr_area_id: '30000000-0000-4000-8000-000000000003', display_name: 'Our Space 🔥' }],
  project_map: [{
    vikunja_project_id: 103,
    mindwtr_project_id: '40000000-0000-4000-8000-000000000004',
    area_vikunja_project_id: 101,
    display_name: 'Proyecto X',
  }],
};

function dataWith(extraTasks = [], extraProjects = []) {
  const data = model.parseData(FIXTURE);
  data.areas.push({
    id: BRIDGE_SEED.area_map[0].mindwtr_area_id,
    name: 'Our Space 🔥', order: 0, createdAt: OLD, updatedAt: OLD, rev: 1,
  });
  data.projects.push({
    id: BRIDGE_SEED.project_map[0].mindwtr_project_id,
    title: 'Proyecto X', status: 'active', color: '#94a3b8', order: 5,
    tagIds: [], areaId: BRIDGE_SEED.area_map[0].mindwtr_area_id,
    createdAt: OLD, updatedAt: OLD, rev: 1,
  });
  data.tasks.push(...extraTasks);
  data.projects.push(...extraProjects);
  return model.serializeData(data);
}

function makeWorld({ data, tasksByProject = { 101: [], 102: [], 103: [] }, seed = {} }) {
  const db = makeFakeDb({ ...BRIDGE_SEED, ...seed });
  return {
    db,
    vikunja: makeFakeVikunja({ projects: structuredClone(PROJECTS), tasksByProject, labels: [] }),
    webdav: makeFakeWebdav(data),
    anytype: makeFakeAnytype(),
    atvkDb: makeFakeAtvkDb(),
  };
}

async function cycle(world, dryRun = false) {
  return runCycle({
    config: CONFIG,
    pool: world.db.pool,
    vikunja: world.vikunja,
    webdav: world.webdav,
    anytype: world.anytype,
    atvkPool: world.atvkDb,
    dryRun,
    now: NOW,
  });
}

test('una tarea nueva de Mindwtr nace en Vikunja y nunca llama Anytype', async () => {
  const world = makeWorld({
    data: dataWith([{
      id: TASK_ID,
      title: 'Capturada desde Mindwtr',
      description: 'Contexto',
      status: 'next',
      projectId: BRIDGE_SEED.project_map[0].mindwtr_project_id,
      dueDate: '2026-08-20', contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
    }]),
  });
  const result = await cycle(world);

  assert.equal(world.vikunja.calls.createTask.length, 1);
  const created = world.vikunja.calls.createTask[0];
  assert.equal(created.projectId, 103);
  assert.match(created.task.description, /mindwtr-vikunja:v1:task/);
  assert.equal(world.anytype.calls.createObject.length, 0);
  assert.equal(world.db.state.capture_map[0].state, 'adopted');
  assert.equal(world.db.state.capture_map[0].vikunja_id, created.task.id);
  assert.equal(
    world.db.state.task_map.find((row) => Number(row.vikunja_task_id) === created.task.id).mindwtr_task_id,
    TASK_ID,
  );
  assert.ok(result.detail.actions.some((action) => action.type === 'capture_create_vikunja'));
});

test('un proyecto Mindwtr y su tarea nacen directamente en Vikunja en el mismo ciclo', async () => {
  const areaId = BRIDGE_SEED.area_map[0].mindwtr_area_id;
  const world = makeWorld({
    data: dataWith([{
      id: TASK_ID, title: 'Tarea del proyecto nuevo', status: 'next', projectId: PROJECT_ID,
      contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
    }], [{
      id: PROJECT_ID, title: 'Proyecto nuevo', status: 'active', areaId,
      tagIds: [], createdAt: OLD, updatedAt: OLD, rev: 1,
    }]),
  });
  await cycle(world);

  assert.equal(world.vikunja.calls.createProject.length, 1);
  assert.equal(world.vikunja.calls.createTask.length, 1);
  const project = world.vikunja.calls.createProject[0];
  assert.equal(world.vikunja.calls.createTask[0].projectId, project.id);
  assert.equal(world.anytype.calls.createObject.length, 0);
  assert.equal(
    world.db.state.project_map.find((row) => Number(row.vikunja_project_id) === project.id).mindwtr_project_id,
    PROJECT_ID,
  );
});

test('capture_map adopted impide repetir una alta Mindwtr', async () => {
  const world = makeWorld({
    data: dataWith([{
      id: TASK_ID, title: 'Ya capturada', status: 'next',
      projectId: BRIDGE_SEED.project_map[0].mindwtr_project_id,
      contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
    }]),
    seed: {
      ...BRIDGE_SEED,
      capture_map: [{
        id: 1, origin: 'mindwtr', kind: 'task', mindwtr_id: TASK_ID,
        vikunja_id: 601, state: 'adopted', created_at: OLD,
      }],
    },
  });
  await cycle(world);
  assert.equal(world.vikunja.calls.createTask.length, 0);
});

test('recupera por marcador una creación Vikunja interrumpida sin duplicarla', async () => {
  const remote = {
    id: 601, project_id: 103, title: 'Recuperable', done: false, labels: [],
    description: captureMarker('task', TASK_ID), created: OLD,
  };
  const world = makeWorld({
    data: dataWith([{
      id: TASK_ID, title: 'Recuperable', status: 'next',
      projectId: BRIDGE_SEED.project_map[0].mindwtr_project_id,
      contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
    }]),
    tasksByProject: { 101: [], 102: [], 103: [remote] },
    seed: {
      ...BRIDGE_SEED,
      capture_map: [{
        id: 1, origin: 'mindwtr', kind: 'task', mindwtr_id: TASK_ID,
        vikunja_id: null, state: 'creating', created_at: OLD,
      }],
    },
  });
  await cycle(world);
  assert.equal(world.vikunja.calls.createTask.length, 0);
  assert.equal(world.db.state.capture_map[0].state, 'adopted');
  assert.equal(world.db.state.capture_map[0].vikunja_id, 601);
  assert.equal(world.db.state.task_map.find((row) => row.vikunja_task_id === 601).mindwtr_task_id, TASK_ID);
});

test('una tarea nacida en Vikunja se espeja pero el bridge no escribe Anytype', async () => {
  const world = makeWorld({
    data: dataWith(),
    tasksByProject: {
      101: [], 102: [],
      103: [{ id: 777, project_id: 103, title: 'Nacida en Vikunja', done: false, labels: [], created: OLD }],
    },
  });
  const result = await cycle(world);
  assert.equal(world.anytype.calls.createObject.length, 0);
  assert.ok(result.detail.actions.some((action) => action.type === 'create_mirror' && action.vikunja_task_id === 777));
});

test('dry-run planifica la salida a Vikunja sin escrituras', async () => {
  const world = makeWorld({
    data: dataWith([{
      id: TASK_ID, title: 'Planeada', status: 'next',
      projectId: BRIDGE_SEED.project_map[0].mindwtr_project_id,
      contexts: [], tags: [], createdAt: OLD, updatedAt: OLD, rev: 1,
    }]),
  });
  const result = await cycle(world, true);
  assert.ok(result.detail.actions.some((action) => action.type === 'capture_create_vikunja'));
  assert.equal(world.vikunja.calls.createTask.length, 0);
  assert.equal(world.db.state.capture_map.length, 0);
  assert.equal(world.anytype.calls.createObject.length, 0);
});
