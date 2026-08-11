'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../src/mindwtr-model');
const gtd = require('../src/gtd-mapping');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'data.json'), 'utf8');
const DEVICE = '00000000-0000-4000-8000-00000000b71d';
const NOW = '2026-07-27T12:00:00.000Z';

const helpers = {
  mindwtrDateOnly: gtd.mindwtrDateOnly,
  normalizeContexts: gtd.normalizeContexts,
  normalizeTags: gtd.normalizeTags,
};

test('parseData valida la forma y serializeData preserva campos desconocidos', () => {
  const data = model.parseData(FIXTURE);
  const personal = data.tasks.find((task) => task.title === 'Tarea personal');
  assert.deepEqual(personal.campoDesconocidoFuturo, { conservar: true });

  const reparsed = model.parseData(model.serializeData(data));
  assert.deepEqual(
    reparsed.tasks.find((task) => task.title === 'Tarea personal'),
    personal,
  );
});

test('touch incrementa rev y firma revBy', () => {
  const entity = { rev: 5, revBy: 'otro', updatedAt: 'antes' };
  model.touch(entity, DEVICE, NOW);
  assert.equal(entity.rev, 6);
  assert.equal(entity.revBy, DEVICE);
  assert.equal(entity.updatedAt, NOW);

  const fresh = {};
  model.touch(fresh, DEVICE, NOW);
  assert.equal(fresh.rev, 1);
});

test('applyTaskPatch aplica cambios, sube rev una vez y respeta no-cambios', () => {
  const data = model.parseData(FIXTURE);
  const task = model.createMirrorTask(data, { title: 'Espejo', status: 'inbox' }, DEVICE, NOW);
  assert.equal(task.rev, 1);

  const changed = model.applyTaskPatch(task, {
    description: 'Contenido útil',
    gtd_status: 'next',
    priority: 'high',
    due_date: '2026-07-30',
  }, DEVICE, NOW);
  assert.equal(changed, true);
  assert.equal(task.status, 'next');
  assert.equal(task.description, 'Contenido útil');
  assert.equal(task.priority, 'high');
  assert.equal(task.dueDate, '2026-07-30');
  assert.equal(task.rev, 2);

  const unchanged = model.applyTaskPatch(task, { gtd_status: 'next' }, DEVICE, NOW);
  assert.equal(unchanged, false);
  assert.equal(task.rev, 2);
});

test('done y reapertura', () => {
  const data = model.parseData(FIXTURE);
  const task = model.createMirrorTask(data, { title: 'Espejo', status: 'next' }, DEVICE, NOW);
  model.applyTaskPatch(task, { done: true }, DEVICE, NOW);
  assert.equal(task.status, 'done');
  assert.equal(task.completedAt, NOW);

  model.applyTaskPatch(task, { done: false, reopen_status: 'waiting' }, DEVICE, NOW);
  assert.equal(task.status, 'waiting');
  assert.equal(task.completedAt, undefined);
});

test('archiveTask y tombstones', () => {
  const data = model.parseData(FIXTURE);
  const task = model.createMirrorTask(data, { title: 'Espejo', status: 'done' }, DEVICE, NOW);
  assert.equal(model.archiveTask(task, DEVICE, NOW), true);
  assert.equal(task.status, 'archived');
  assert.equal(model.archiveTask(task, DEVICE, NOW), false);

  assert.equal(model.isTombstoned({ deletedAt: NOW }), true);
  assert.equal(model.isTombstoned({ purgedAt: NOW }), true);
  assert.equal(model.isTombstoned({}), false);
});

test('taskSnapshot produce los campos lógicos del contrato', () => {
  const data = model.parseData(FIXTURE);
  const personal = data.tasks.find((task) => task.title === 'Tarea personal');
  const snapshot = model.taskSnapshot(personal, helpers);
  assert.equal(snapshot.gtd_status, 'next');
  assert.equal(snapshot.description, 'Tarea personal que el bridge jamás debe tocar.');
  assert.equal(snapshot.done, false);
  assert.equal(snapshot.due_date, '2026-07-27');
  assert.equal(snapshot.start_time, '2026-07-25');
  assert.deepEqual(snapshot.contexts, ['@codex', '@work']);
  assert.deepEqual(snapshot.tags, []);
});

test('createMirrorTask con proyecto no lleva areaId', () => {
  const data = model.parseData(FIXTURE);
  const area = model.ensureArea(data, { name: 'Space X' }, DEVICE, NOW);
  const project = model.ensureProject(data, { title: 'Proyecto X', areaId: area.id }, DEVICE, NOW);
  const withProject = model.createMirrorTask(data, {
    title: 'A', description: 'Descripción segura', status: 'next', projectId: project.id, areaId: area.id,
  }, DEVICE, NOW);
  assert.equal(withProject.projectId, project.id);
  assert.equal(withProject.description, 'Descripción segura');
  assert.equal(withProject.areaId, undefined);

  const withoutProject = model.createMirrorTask(data, {
    title: 'B', status: 'inbox', areaId: area.id,
  }, DEVICE, NOW);
  assert.equal(withoutProject.areaId, area.id);
});
