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

test('rename en Vikunja/Anytype renombra el proyecto y el área espejo', async () => {
  const projects = [
    { id: 100, title: 'ANYTYPE', parent_project_id: 0 },
    { id: 101, title: 'Our Space 🔥', parent_project_id: 100 },
    { id: 103, title: 'Proyecto X', parent_project_id: 101 },
  ];
  const tasks = {
    101: [],
    103: [{ id: 502, project_id: 103, title: 'Tarea', done: false, labels: [] }],
  };
  const labels = [
    { id: 9, title: 'GTD: Next' }, { id: 10, title: 'GTD: Waiting' },
    { id: 11, title: 'GTD: Someday' }, { id: 12, title: 'GTD: Reference' },
  ];

  // Ciclo 1: bootstrap.
  const db1 = makeFakeDb();
  const vikunja1 = makeFakeVikunja({ projects, tasksByProject: tasks, labels });
  const webdav1 = makeFakeWebdav(FIXTURE);
  await runCycle({ config: BASE_CONFIG, pool: db1.pool, vikunja: vikunja1, webdav: webdav1, now: NOW });
  const body = webdav1.record.puts.at(-1).body;

  // Ciclo 2: los títulos cambiaron en Vikunja (venían de Anytype).
  const renamed = projects.map((p) => ({
    ...p,
    title: p.id === 103 ? 'Proyecto X v2' : p.id === 101 ? 'Our Space renombrado' : p.title,
  }));
  const db2 = makeFakeDb({
    task_map: db1.state.task_map,
    task_field_state: db1.state.task_field_state,
    area_map: db1.state.area_map,
    project_map: db1.state.project_map,
  });
  const vikunja2 = makeFakeVikunja({ projects: renamed, tasksByProject: tasks, labels });
  const webdav2 = makeFakeWebdav(body);
  const result = await runCycle({ config: BASE_CONFIG, pool: db2.pool, vikunja: vikunja2, webdav: webdav2, now: NOW });

  assert.ok(result.detail.actions.some((a) => a.type === 'rename_project'));
  assert.ok(result.detail.actions.some((a) => a.type === 'rename_area'));
  const written = model.parseData(webdav2.record.puts.at(-1).body);
  assert.ok(written.projects.some((p) => p.title === 'Proyecto X v2'));
  assert.ok(written.areas.some((a) => a.name === 'Our Space renombrado'));
});
