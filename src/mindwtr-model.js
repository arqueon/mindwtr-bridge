'use strict';

// Mutación pura del data.json de Mindwtr. Sin I/O. Reglas duras:
// - Toda entidad mutada incrementa rev y firma revBy con el uuid del bridge
//   (protocolo de merge multi-dispositivo de la propia app: gana rev mayor).
// - Preservación por spread: jamás una whitelist de campos — el data.json
//   trae claves que el bridge no modela (attachments, checklist, settings…).
// - El bridge SOLO gestiona entidades cuyo id está en sus mapas; el resto del
//   archivo se conserva byte a byte (salvo la serialización JSON).

const crypto = require('node:crypto');

const MIRROR_STATUSES = Object.freeze(['inbox', 'next', 'waiting', 'someday', 'reference']);

function parseData(body) {
  const data = JSON.parse(body);
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) {
    throw new TypeError('data.json inesperado: falta la lista tasks');
  }
  for (const key of ['areas', 'projects']) {
    if (data[key] === undefined) data[key] = [];
    if (!Array.isArray(data[key])) throw new TypeError(`data.json inesperado: ${key} no es lista`);
  }
  return data;
}

function serializeData(data) {
  return JSON.stringify(data, null, 2);
}

function uuid() {
  return crypto.randomUUID();
}

function touch(entity, deviceUuid, nowIso) {
  entity.rev = (Number.isInteger(entity.rev) && entity.rev >= 0 ? entity.rev : 0) + 1;
  entity.revBy = deviceUuid;
  entity.updatedAt = nowIso;
  return entity;
}

function findById(list, id) {
  return (list ?? []).find((item) => item?.id === id) ?? null;
}

function isTombstoned(entity) {
  return Boolean(entity?.deletedAt || entity?.purgedAt);
}

// Snapshot lógico de un espejo para el three-way merge. Mismos nombres de
// campo que task_field_state.field_name.
function taskSnapshot(task, { mindwtrDateOnly, normalizeContexts, normalizeTags }) {
  return {
    title: String(task?.title ?? '').normalize('NFC').trim(),
    description: String(task?.description ?? '').normalize('NFC').trim() || null,
    done: task?.status === 'done' || task?.status === 'archived',
    gtd_status: MIRROR_STATUSES.includes(task?.status) ? task.status : null,
    priority: task?.priority ?? null,
    due_date: mindwtrDateOnly(task?.dueDate),
    start_time: mindwtrDateOnly(task?.startTime),
    contexts: normalizeContexts(task?.contexts),
    tags: normalizeTags(task?.tags),
    focus: Boolean(task?.isFocusedToday),
    project: task?.projectId ?? null,
    area: task?.areaId ?? null,
  };
}

function ensureArea(data, { name, color, icon }, deviceUuid, nowIso) {
  const area = {
    id: uuid(),
    name,
    ...(color ? { color } : {}),
    ...(icon ? { icon } : {}),
    order: data.areas.length,
    createdAt: nowIso,
    updatedAt: nowIso,
    rev: 1,
    revBy: deviceUuid,
  };
  data.areas.push(area);
  return area;
}

function ensureProject(data, { title, areaId, color }, deviceUuid, nowIso) {
  const project = {
    id: uuid(),
    title,
    status: 'active',
    color: color || '#94a3b8',
    order: data.projects.length,
    tagIds: [],
    ...(areaId ? { areaId } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    rev: 1,
    revBy: deviceUuid,
  };
  data.projects.push(project);
  return project;
}

function createMirrorTask(data, fields, deviceUuid, nowIso) {
  const task = {
    id: uuid(),
    title: fields.title,
    ...(fields.description ? { description: fields.description } : {}),
    status: fields.status ?? 'inbox',
    ...(fields.priority ? { priority: fields.priority } : {}),
    ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    ...(fields.startTime ? { startTime: fields.startTime } : {}),
    ...(fields.projectId ? { projectId: fields.projectId } : {}),
    ...(fields.areaId && !fields.projectId ? { areaId: fields.areaId } : {}),
    ...(fields.isFocusedToday ? { isFocusedToday: true } : {}),
    contexts: fields.contexts ?? [],
    tags: fields.tags ?? [],
    taskMode: 'task',
    pushCount: 0,
    suppressMindwtrReminders: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    rev: 1,
    revBy: deviceUuid,
  };
  data.tasks.push(task);
  return task;
}

// Aplica un patch de campos lógicos a un espejo existente. Devuelve true si
// hubo cambios (y entonces la entidad quedó tocada con rev+1).
function applyTaskPatch(task, patch, deviceUuid, nowIso) {
  let changed = false;
  const assign = (key, value) => {
    const normalized = value === null ? undefined : value;
    if (task[key] !== normalized) {
      if (normalized === undefined) delete task[key];
      else task[key] = normalized;
      changed = true;
    }
  };

  if ('title' in patch) assign('title', patch.title);
  if ('description' in patch) assign('description', patch.description);
  if ('priority' in patch) assign('priority', patch.priority);
  if ('due_date' in patch) assign('dueDate', patch.due_date);
  if ('start_time' in patch) assign('startTime', patch.start_time);
  if ('focus' in patch) assign('isFocusedToday', patch.focus ? true : undefined);
  if ('project' in patch) {
    assign('projectId', patch.project);
    // areaId solo aplica sin projectId (regla del modelo de la app).
    if (patch.project) assign('areaId', undefined);
  }
  if ('area' in patch && !task.projectId) assign('areaId', patch.area);
  if ('contexts' in patch) {
    const next = patch.contexts ?? [];
    if (JSON.stringify(task.contexts ?? []) !== JSON.stringify(next)) {
      task.contexts = next;
      changed = true;
    }
  }
  if ('tags' in patch) {
    const next = patch.tags ?? [];
    if (JSON.stringify(task.tags ?? []) !== JSON.stringify(next)) {
      task.tags = next;
      changed = true;
    }
  }
  if ('gtd_status' in patch && patch.gtd_status) {
    if (task.status !== patch.gtd_status) {
      task.status = patch.gtd_status;
      delete task.completedAt;
      changed = true;
    }
  }
  if ('done' in patch) {
    if (patch.done && task.status !== 'done' && task.status !== 'archived') {
      task.status = 'done';
      task.completedAt = nowIso;
      changed = true;
    } else if (!patch.done && (task.status === 'done' || task.status === 'archived')) {
      task.status = patch.reopen_status ?? 'next';
      delete task.completedAt;
      changed = true;
    }
  }

  if (changed) touch(task, deviceUuid, nowIso);
  return changed;
}

// Espejo retirado (done estable u fuera de alcance): pasa a archived.
function archiveTask(task, deviceUuid, nowIso) {
  if (task.status === 'archived') return false;
  task.status = 'archived';
  if (!task.completedAt) task.completedAt = nowIso;
  task.isFocusedToday = false;
  touch(task, deviceUuid, nowIso);
  return true;
}

module.exports = {
  MIRROR_STATUSES,
  applyTaskPatch,
  archiveTask,
  createMirrorTask,
  ensureArea,
  ensureProject,
  findById,
  isTombstoned,
  parseData,
  serializeData,
  taskSnapshot,
  touch,
  uuid,
};
