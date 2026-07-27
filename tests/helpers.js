'use strict';

// Dobles de prueba: Postgres (enrutador de SQL sobre estado en memoria),
// Vikunja (fixture + registro de escrituras) y WebDAV (cuerpo + ETag).

function makeFakeDb(seed = {}) {
  const state = {
    bridge_state: seed.bridge_state ?? [{ id: 1, device_uuid: '00000000-0000-4000-8000-00000000b71d' }],
    area_map: seed.area_map ?? [],
    project_map: seed.project_map ?? [],
    task_map: seed.task_map ?? [],
    task_field_state: seed.task_field_state ?? [],
    sync_run: [],
    sync_error: [],
  };

  const client = {
    state,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (text.startsWith('SELECT pg_advisory_unlock')) return { rows: [] };
      if (text.startsWith('SELECT * FROM bridge_state')) return { rows: state.bridge_state };
      if (text.startsWith('SELECT * FROM area_map')) return { rows: state.area_map };
      if (text.startsWith('SELECT * FROM project_map')) return { rows: state.project_map };
      if (text.startsWith('SELECT * FROM task_map WHERE')) {
        return { rows: state.task_map.filter((row) => Number(row.vikunja_task_id) === Number(params[0])) };
      }
      if (text.startsWith('SELECT * FROM task_map')) return { rows: state.task_map };
      if (text.startsWith('SELECT * FROM task_field_state')) return { rows: state.task_field_state };
      if (text.startsWith('INSERT INTO task_map')) {
        state.task_map.push({ vikunja_task_id: params[0], mindwtr_task_id: params[1], state: 'active' });
        return { rows: [] };
      }
      if (text.startsWith('UPDATE task_map SET state')) {
        const match = text.match(/state = '(\w+)'/);
        const row = state.task_map.find((item) => Number(item.vikunja_task_id) === Number(params[0]));
        if (row) row.state = match[1];
        return { rows: [] };
      }
      if (text.startsWith('DELETE FROM task_map')) {
        state.task_map = state.task_map.filter((item) => Number(item.vikunja_task_id) !== Number(params[0]));
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO task_field_state')) {
        const record = {
          vikunja_task_id: params[0],
          field_name: params[1],
          last_vikunja_value: JSON.parse(params[2]),
          last_mindwtr_value: JSON.parse(params[2]),
          last_common_value: JSON.parse(params[2]),
          last_origin: params[3] ?? 'bootstrap',
        };
        const existing = state.task_field_state.find(
          (item) => Number(item.vikunja_task_id) === Number(params[0]) && item.field_name === params[1],
        );
        if (existing && text.includes('ON CONFLICT')) Object.assign(existing, record);
        else state.task_field_state.push(record);
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO area_map')) {
        state.area_map.push({ vikunja_project_id: params[0], mindwtr_area_id: params[1], display_name: params[2] });
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO project_map')) {
        state.project_map.push({
          vikunja_project_id: params[0],
          mindwtr_project_id: params[1],
          area_vikunja_project_id: params[2],
          display_name: params[3],
        });
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO sync_run')) {
        state.sync_run.push({ params });
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO sync_error')) {
        state.sync_error.push({ params });
        return { rows: [] };
      }
      if (text.startsWith('UPDATE bridge_state')) {
        Object.assign(state.bridge_state[0], { last_etag: params[0], last_written_sha256: params[1] });
        return { rows: [] };
      }
      throw new Error(`fakeDb: SQL no enrutado: ${text.slice(0, 90)}`);
    },
    release() {},
  };

  return {
    state,
    pool: { connect: async () => client, end: async () => {} },
  };
}

function makeFakeVikunja({ projects, tasksByProject, labels }) {
  const calls = { updateTask: [], addLabel: [], removeLabel: [], createLabel: [] };
  let nextLabelId = 1000;
  const allLabels = [...labels];
  const flatTasks = new Map();
  for (const list of Object.values(tasksByProject)) {
    for (const task of list) flatTasks.set(task.id, task);
  }
  return {
    calls,
    labels: allLabels,
    async listProjects() { return projects; },
    async listProjectTasks(projectId) { return tasksByProject[projectId] ?? []; },
    async getTask(taskId) { return flatTasks.get(taskId) ?? null; },
    async listLabels() { return allLabels; },
    async createLabel(label) {
      const created = { id: nextLabelId += 1, ...label };
      allLabels.push(created);
      calls.createLabel.push(created);
      return created;
    },
    async addLabel(taskId, labelId) { calls.addLabel.push({ taskId, labelId }); },
    async removeLabel(taskId, labelId) { calls.removeLabel.push({ taskId, labelId }); },
    async updateTask(task, changes) {
      calls.updateTask.push({ taskId: task.id, changes });
      return { ...task, ...changes };
    },
  };
}

function makeFakeWebdav(body, { conflictOnPut = false } = {}) {
  const record = { puts: [] };
  return {
    record,
    async get() { return { body, etag: 'etag-1' }; },
    async putIfMatch(newBody, etag) {
      record.puts.push({ body: newBody, etag });
      if (conflictOnPut) return { ok: false, conflict: true, etag: null };
      return { ok: true, conflict: false, etag: 'etag-2' };
    },
  };
}

const BASE_CONFIG = Object.freeze({
  root_project_title: 'ANYTYPE',
  no_project_title: '00 · Sin proyecto',
  timezone: 'America/Mexico_City',
  default_due_time: '09:00',
  enable_focus: true,
  pilot_task_ids: [],
});

module.exports = { BASE_CONFIG, makeFakeDb, makeFakeVikunja, makeFakeWebdav };
