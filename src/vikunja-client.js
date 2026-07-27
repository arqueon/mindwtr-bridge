'use strict';

// Cliente reducido de la API de Vikunja, derivado de
// vikunja-anytype-sync/src/vikunja-client.js (commit 238f617). Solo lo que el
// bridge necesita: proyectos, tareas, labels. Sin buckets, relaciones ni bulk.

const { HttpError, requestJson } = require('./lib/http-json');

// Campos que un update de tarea debe reenviar para no perderlos: la API de
// Vikunja reemplaza el modelo completo en POST /tasks/{id}. Misma lista que
// usa atvk en producción.
const MUTABLE_VIKUNJA_FIELDS = Object.freeze([
  'title',
  'description',
  'done',
  'due_date',
  'priority',
  'project_id',
  'repeat_after',
  'repeat_mode',
  'start_date',
  'end_date',
  'percent_done',
  'hex_color',
]);

function mutablePayload(task, changes) {
  const payload = {};
  for (const field of MUTABLE_VIKUNJA_FIELDS) {
    if (task[field] !== undefined && task[field] !== null) payload[field] = task[field];
  }
  Object.assign(payload, changes);
  if (!payload.title) payload.title = String(task.title || '(sin título)');
  return payload;
}

class VikunjaClient {
  constructor({ baseUrl, token, timeoutMs = 30_000 }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    return requestJson({
      baseUrl: this.baseUrl,
      path,
      timeoutMs: this.timeoutMs,
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(options.headers ?? {}),
      },
    });
  }

  async listPaginated(path, query = {}) {
    const all = [];
    const perPage = Number(query.per_page ?? 100);
    for (let page = 1; page <= 1000; page += 1) {
      const response = await this.request(path, {
        query: { ...query, page, per_page: perPage },
      });
      const batch = Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.data?.data)
          ? response.data.data
          : [];
      all.push(...batch);
      const totalPages = Number(response.headers.get('x-pagination-total-pages') || 0);
      if ((totalPages && page >= totalPages) || (!totalPages && batch.length < perPage)) {
        return all;
      }
      if (batch.length === 0) return all;
    }
    throw new Error(`Vikunja excedió el límite defensivo de paginación en ${path}.`);
  }

  async listProjects() {
    return this.listPaginated('projects');
  }

  async listProjectTasks(projectId, query = {}) {
    return this.listPaginated(`projects/${projectId}/tasks`, query);
  }

  async getTask(taskId, query = {}) {
    try {
      return (await this.request(`tasks/${taskId}`, { query })).data;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async updateTask(task, changes) {
    return (await this.request(`tasks/${task.id}`, {
      method: 'POST',
      body: mutablePayload(task, changes),
    })).data;
  }

  async listLabels() {
    return this.listPaginated('labels');
  }

  async createLabel(label) {
    return (await this.request('labels', { method: 'PUT', body: label })).data;
  }

  async addLabel(taskId, labelId) {
    return (await this.request(`tasks/${taskId}/labels`, {
      method: 'PUT',
      body: { label_id: Number(labelId) },
    })).data;
  }

  async removeLabel(taskId, labelId) {
    return (await this.request(`tasks/${taskId}/labels/${labelId}`, {
      method: 'DELETE',
    })).data;
  }
}

module.exports = { MUTABLE_VIKUNJA_FIELDS, VikunjaClient, mutablePayload };
