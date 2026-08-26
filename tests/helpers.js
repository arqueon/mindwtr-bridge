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
    capture_map: seed.capture_map ?? [],
    sync_run: [],
    sync_error: [],
  };
  let nextCaptureId = state.capture_map.reduce((max, row) => Math.max(max, row.id ?? 0), 0);

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
        const exists = state.task_map.some((row) => Number(row.vikunja_task_id) === Number(params[0]));
        if (!exists) {
          state.task_map.push({ vikunja_task_id: params[0], mindwtr_task_id: params[1], state: 'active' });
        }
        return { rows: [] };
      }
      if (text.startsWith('SELECT * FROM capture_map')) return { rows: state.capture_map };
      if (text.startsWith('INSERT INTO capture_map')) {
        nextCaptureId += 1;
        const direct = text.includes("VALUES ('mindwtr'");
        state.capture_map.push({
          id: nextCaptureId,
          origin: direct ? 'mindwtr' : params[0],
          kind: direct ? params[0] : params[1],
          mindwtr_id: direct ? params[1] : params[2],
          vikunja_id: direct ? null : params[3],
          anytype_space_id: direct ? null : params[4],
          anytype_object_id: null,
          state: 'creating',
          created_at: new Date().toISOString(),
        });
        return { rows: [{ id: nextCaptureId }] };
      }
      if (text.startsWith('UPDATE capture_map')) {
        const match = text.match(/state = '(\w+)'/);
        const row = state.capture_map.find((item) => Number(item.id) === Number(params[0]));
        if (row) {
          row.state = match[1];
          if (match[1] === 'pending') row.anytype_object_id = params[1];
          if (match[1] === 'adopted' && params[1] !== undefined) row.vikunja_id = params[1];
        }
        return { rows: [] };
      }
      if (text.startsWith('UPDATE task_map SET state')) {
        const match = text.match(/state = '(\w+)'/);
        const row = state.task_map.find((item) => Number(item.vikunja_task_id) === Number(params[0]));
        if (row) row.state = match[1];
        return { rows: [] };
      }
      if (text.startsWith('UPDATE task_map SET provenance_marker')) {
        const row = state.task_map.find((item) => Number(item.vikunja_task_id) === Number(params[0]));
        if (row && !row.provenance_marker) row.provenance_marker = params[1];
        return { rows: [] };
      }
      if (text.startsWith('UPDATE task_map SET vikunja_task_id')) {
        const row = state.task_map.find((item) => Number(item.vikunja_task_id) === Number(params[0]));
        if (row) {
          row.vikunja_task_id = Number(params[1]);
          for (const field of state.task_field_state) {
            if (Number(field.vikunja_task_id) === Number(params[0])) field.vikunja_task_id = Number(params[1]);
          }
        }
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
        if (existing && text.includes('DO NOTHING')) { /* conserva */ }
        else if (existing && text.includes('ON CONFLICT')) Object.assign(existing, record);
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

function makeFakeAtvkDb({ channels = [], taskRows = [], projectRows = [] } = {}) {
  return {
    async query(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.includes('FROM channel_map')) return { rows: channels };
      if (text.includes('FROM task_map')) return { rows: taskRows };
      if (text.includes('FROM project_map')) return { rows: projectRows };
      throw new Error(`fakeAtvkDb: SQL no enrutado: ${text.slice(0, 60)}`);
    },
  };
}

function makeFakeAnytype() {
  const calls = { createObject: [], updateObject: [], createTag: [] };
  let nextId = 0;
  return {
    calls,
    async createObject(spaceId, payload) {
      nextId += 1;
      const object = { id: `obj-cap-${nextId}`, ...payload };
      calls.createObject.push({ spaceId, payload, id: object.id });
      return object;
    },
    async getObject() { return { type: { key: 'project' } }; },
    async updateObject(spaceId, objectId, patch) {
      calls.updateObject.push({ spaceId, objectId, patch });
      return { id: objectId };
    },
    async listProperties() {
      return [
        { id: 'prop-tag', key: 'tag' },
        { id: 'prop-due', key: 'due_date' },
        { id: 'prop-linked', key: 'linked_projects' },
      ];
    },
    async listTags() { return []; },
    async createTag(spaceId, propertyId, tag) {
      nextId += 1;
      const created = { id: `tag-cap-${nextId}`, ...tag };
      calls.createTag.push({ spaceId, propertyId, tag: created });
      return created;
    },
  };
}

function makeFakeVikunja({ projects, tasksByProject, labels }) {
  const calls = {
    updateTask: [], addLabel: [], removeLabel: [], createLabel: [], updateProject: [],
    createProject: [], createTask: [],
  };
  let nextLabelId = 1000;
  let nextProjectId = Math.max(0, ...projects.map((project) => Number(project.id))) + 1;
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
    async createProject(project) {
      const created = { id: nextProjectId += 1, created: new Date().toISOString(), ...project };
      projects.push(created);
      tasksByProject[created.id] = [];
      calls.createProject.push(created);
      return created;
    },
    async createTask(projectId, task) {
      const nextTaskId = Math.max(0, ...flatTasks.keys()) + 1;
      const created = {
        id: nextTaskId,
        project_id: Number(projectId),
        labels: [],
        created: new Date().toISOString(),
        ...task,
      };
      if (!tasksByProject[projectId]) tasksByProject[projectId] = [];
      tasksByProject[projectId].push(created);
      flatTasks.set(created.id, created);
      calls.createTask.push({ projectId: Number(projectId), task: created });
      return created;
    },
    async addLabel(taskId, labelId) { calls.addLabel.push({ taskId, labelId }); },
    async removeLabel(taskId, labelId) { calls.removeLabel.push({ taskId, labelId }); },
    async updateTask(task, changes) {
      calls.updateTask.push({ taskId: task.id, changes });
      return { ...task, ...changes };
    },
    async updateProject(projectId, project) {
      calls.updateProject.push({ projectId, project });
      return { id: projectId, ...project };
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

module.exports = { BASE_CONFIG, makeFakeAnytype, makeFakeAtvkDb, makeFakeDb, makeFakeVikunja, makeFakeWebdav };
