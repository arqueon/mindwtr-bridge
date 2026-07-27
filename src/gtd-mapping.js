'use strict';

// Mapeo entre el vocabulario de Vikunja (labels, priority int, fechas
// RFC3339) y el de Mindwtr (status GTD, priority enum, fechas YYYY-MM-DD,
// contexts/tags como strings). Todo puro, sin I/O.

// Partición del namespace de labels de Vikunja. Tres subconjuntos disjuntos;
// el bridge solo escribe add/remove dentro del subconjunto que corresponde y
// nunca toca labels fuera de él.
const GTD_LABEL_TO_STATUS = Object.freeze({
  'GTD: Next': 'next',
  'GTD: Waiting': 'waiting',
  'GTD: Someday': 'someday',
  'GTD: Reference': 'reference',
});

// Precedencia si una tarea acumula más de una label GTD (edición humana):
// se refleja la más accionable y se avisa, sin auto-limpiar.
const GTD_STATUS_PRECEDENCE = Object.freeze(['next', 'waiting', 'someday', 'reference']);

const STATUS_TO_GTD_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(GTD_LABEL_TO_STATUS).map(([label, status]) => [status, label])),
);

const GTD_LABEL_TITLES = Object.freeze(Object.keys(GTD_LABEL_TO_STATUS));

function normalizeLabelTitle(title) {
  return String(title ?? '').normalize('NFC').trim();
}

function isGtdLabel(title) {
  return Object.hasOwn(GTD_LABEL_TO_STATUS, normalizeLabelTitle(title));
}

function isContextLabel(title) {
  return normalizeLabelTitle(title).startsWith('@');
}

// labels: [{id, title}] → { gtd: [titles], contexts: [titles], tags: [titles] }
function partitionLabels(labels) {
  const gtd = [];
  const contexts = [];
  const tags = [];
  for (const label of labels ?? []) {
    const title = normalizeLabelTitle(label?.title);
    if (!title) continue;
    if (isGtdLabel(title)) gtd.push(title);
    else if (isContextLabel(title)) contexts.push(title);
    else tags.push(title);
  }
  return {
    gtd: [...new Set(gtd)].sort(),
    contexts: [...new Set(contexts)].sort(),
    tags: [...new Set(tags)].sort(),
  };
}

// Subconjunto GTD de labels → status de Mindwtr. Sin labels GTD = inbox.
function statusFromGtdLabels(gtdTitles) {
  const statuses = new Set((gtdTitles ?? []).map((title) => GTD_LABEL_TO_STATUS[normalizeLabelTitle(title)]).filter(Boolean));
  for (const status of GTD_STATUS_PRECEDENCE) {
    if (statuses.has(status)) {
      return { status, ambiguous: statuses.size > 1 };
    }
  }
  return { status: 'inbox', ambiguous: false };
}

function gtdLabelForStatus(status) {
  return STATUS_TO_GTD_LABEL[status] ?? null;
}

// Priority: Mindwtr low|medium|high|urgent ↔ Vikunja 1..4 (5 «DO NOW» se lee
// como urgent; nunca se escribe). Ausente ↔ 0/undefined.
const MINDWTR_PRIORITY_TO_VIKUNJA = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
});

function vikunjaPriorityToMindwtr(priority) {
  const value = Number(priority ?? 0);
  if (value <= 0) return null;
  if (value === 1) return 'low';
  if (value === 2) return 'medium';
  if (value === 3) return 'high';
  return 'urgent';
}

function mindwtrPriorityToVikunja(priority) {
  return MINDWTR_PRIORITY_TO_VIKUNJA[priority] ?? 0;
}

// --- Fechas ---------------------------------------------------------------
// Vikunja guarda RFC3339 con hora; Mindwtr guarda YYYY-MM-DD. La comparación
// lógica es a granularidad de fecha en la zona del usuario: así un cambio de
// hora en Vikunja no rebota, y un cambio de día sí se propaga.

const VIKUNJA_NULL_DATE_PREFIX = '0001-01-01';

function isVikunjaNullDate(value) {
  return !value || String(value).startsWith(VIKUNJA_NULL_DATE_PREFIX);
}

// RFC3339 → 'YYYY-MM-DD' en la zona dada.
function dateInTimezone(value, timeZone) {
  if (isVikunjaNullDate(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(parsed);
}

// Fecha 'YYYY-MM-DD' de Mindwtr (puede venir con hora ISO; se recorta).
function mindwtrDateOnly(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// Instante UTC para «dateStr a las timeStr en timeZone», resuelto en dos
// pasadas contra Intl (sin dependencias de zona horaria).
function zonedDateTimeToUtc(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const read = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const readUtc = Date.UTC(
      Number(read.year),
      Number(read.month) - 1,
      Number(read.day),
      Number(read.hour),
      Number(read.minute),
      Number(read.second),
    );
    guess += Date.UTC(year, month - 1, day, hour, minute, 0, 0) - readUtc;
  }
  return new Date(guess).toISOString();
}

// Nueva fecha (YYYY-MM-DD) desde Mindwtr → RFC3339 para Vikunja, conservando
// la hora local existente del due_date de Vikunja si la había.
function composeVikunjaDate(newDateStr, existingVikunjaDate, timeZone, defaultTime = '09:00') {
  if (!newDateStr) return null;
  let time = defaultTime;
  if (!isVikunjaNullDate(existingVikunjaDate)) {
    const parsed = new Date(existingVikunjaDate);
    if (!Number.isNaN(parsed.getTime())) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(parsed);
      const read = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      time = `${read.hour}:${read.minute}`;
    }
  }
  return zonedDateTimeToUtc(newDateStr, time, timeZone);
}

// --- Contexts -------------------------------------------------------------
// La app permite escribir varios contextos en un solo string («@work @codex»);
// el bridge normaliza a un contexto por entrada, con @ garantizado.
function normalizeContexts(contexts) {
  const out = [];
  for (const raw of contexts ?? []) {
    for (const piece of String(raw ?? '').split(/\s+/)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      out.push(trimmed.startsWith('@') ? trimmed : `@${trimmed}`);
    }
  }
  return [...new Set(out)].sort();
}

function normalizeTags(tags) {
  return [...new Set((tags ?? []).map((tag) => String(tag ?? '').normalize('NFC').trim()).filter(Boolean))].sort();
}

module.exports = {
  GTD_LABEL_TITLES,
  GTD_LABEL_TO_STATUS,
  composeVikunjaDate,
  dateInTimezone,
  gtdLabelForStatus,
  isContextLabel,
  isGtdLabel,
  mindwtrDateOnly,
  mindwtrPriorityToVikunja,
  normalizeContexts,
  normalizeLabelTitle,
  normalizeTags,
  partitionLabels,
  statusFromGtdLabels,
  vikunjaPriorityToMindwtr,
  zonedDateTimeToUtc,
};
