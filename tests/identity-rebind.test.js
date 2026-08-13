'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rebindTaskIdentities, taskProvenanceMarker } = require('../src/identity-rebind');
const { makeFakeDb } = require('./helpers');

const MARKER = '<!-- atvk:v1:0123456789abcdef0123456789abcdef01234567 -->';

test('reasigna el mismo espejo al nuevo id Vikunja y conserva checkpoints', async () => {
  const db = makeFakeDb({
    task_map: [{
      vikunja_task_id: 10,
      mindwtr_task_id: '10000000-0000-4000-8000-000000000001',
      state: 'retired',
      provenance_marker: MARKER,
    }],
    task_field_state: [{
      vikunja_task_id: 10,
      field_name: 'title',
      last_common_value: 'Tarea',
    }],
  });
  const taskRows = db.state.task_map;
  const tasks = new Map([
    [10, null],
    [20, { id: 20, description: `texto\n${MARKER}` }],
  ]);
  const result = await rebindTaskIdentities({ db: await db.pool.connect(), taskRows, vikunjaTasks: tasks });
  assert.equal(result.rebound, 1);
  assert.equal(db.state.task_map[0].vikunja_task_id, 20);
  assert.equal(db.state.task_map[0].mindwtr_task_id, '10000000-0000-4000-8000-000000000001');
  assert.equal(db.state.task_field_state[0].vikunja_task_id, 20);
});

test('extrae el marcador ATVK sin exponer el resto de la descripción', () => {
  assert.equal(taskProvenanceMarker({ description: `privado\n${MARKER}` }), MARKER);
});
