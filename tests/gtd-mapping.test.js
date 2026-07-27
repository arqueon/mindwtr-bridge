'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gtd = require('../src/gtd-mapping');

test('partitionLabels separa GTD, contextos y tags', () => {
  const result = gtd.partitionLabels([
    { id: 1, title: 'GTD: Next' },
    { id: 2, title: '@work' },
    { id: 3, title: 'deep' },
    { id: 4, title: 'GTD: Waiting' },
    { id: 5, title: '  @home ' },
  ]);
  assert.deepEqual(result.gtd, ['GTD: Next', 'GTD: Waiting']);
  assert.deepEqual(result.contexts, ['@home', '@work']);
  assert.deepEqual(result.tags, ['deep']);
});

test('statusFromGtdLabels aplica precedencia y marca ambigüedad', () => {
  assert.deepEqual(gtd.statusFromGtdLabels([]), { status: 'inbox', ambiguous: false });
  assert.deepEqual(gtd.statusFromGtdLabels(['GTD: Someday']), { status: 'someday', ambiguous: false });
  assert.deepEqual(
    gtd.statusFromGtdLabels(['GTD: Someday', 'GTD: Next']),
    { status: 'next', ambiguous: true },
  );
  assert.deepEqual(gtd.statusFromGtdLabels(['GTD: Reference']), { status: 'reference', ambiguous: false });
});

test('prioridad ida y vuelta', () => {
  assert.equal(gtd.mindwtrPriorityToVikunja('low'), 1);
  assert.equal(gtd.mindwtrPriorityToVikunja('urgent'), 4);
  assert.equal(gtd.mindwtrPriorityToVikunja(null), 0);
  assert.equal(gtd.vikunjaPriorityToMindwtr(0), null);
  assert.equal(gtd.vikunjaPriorityToMindwtr(3), 'high');
  // 5 (DO NOW) se lee como urgent y nunca se reescribe si no cambió:
  assert.equal(gtd.vikunjaPriorityToMindwtr(5), 'urgent');
});

test('dateInTimezone recorta a fecha local de CDMX', () => {
  // 03:30Z del 27 = 21:30 del 26 en América/Mexico_City (UTC-6).
  assert.equal(gtd.dateInTimezone('2026-07-27T03:30:00Z', 'America/Mexico_City'), '2026-07-26');
  assert.equal(gtd.dateInTimezone('2026-07-27T18:00:00Z', 'America/Mexico_City'), '2026-07-27');
  assert.equal(gtd.dateInTimezone('0001-01-01T00:00:00Z', 'America/Mexico_City'), null);
  assert.equal(gtd.dateInTimezone(null, 'America/Mexico_City'), null);
});

test('composeVikunjaDate conserva la hora local existente', () => {
  // Due existente a las 17:45 locales; nueva fecha → misma hora local.
  const existing = '2026-07-20T23:45:00Z'; // 17:45 en CDMX
  const composed = gtd.composeVikunjaDate('2026-07-28', existing, 'America/Mexico_City');
  assert.equal(composed, '2026-07-28T23:45:00.000Z');
  assert.equal(gtd.dateInTimezone(composed, 'America/Mexico_City'), '2026-07-28');
});

test('composeVikunjaDate sin hora previa usa la hora canónica', () => {
  const composed = gtd.composeVikunjaDate('2026-07-28', null, 'America/Mexico_City', '09:00');
  assert.equal(gtd.dateInTimezone(composed, 'America/Mexico_City'), '2026-07-28');
  assert.equal(composed, '2026-07-28T15:00:00.000Z'); // 09:00 CDMX = 15:00Z
});

test('anti-flapping: recomponer la misma fecha es un punto fijo', () => {
  const first = gtd.composeVikunjaDate('2026-07-28', null, 'America/Mexico_City');
  const second = gtd.composeVikunjaDate('2026-07-28', first, 'America/Mexico_City');
  assert.equal(first, second);
});

test('normalizeContexts parte strings con varios contextos y garantiza @', () => {
  assert.deepEqual(gtd.normalizeContexts(['@work @codex']), ['@codex', '@work']);
  assert.deepEqual(gtd.normalizeContexts(['casa']), ['@casa']);
  assert.deepEqual(gtd.normalizeContexts([]), []);
  assert.deepEqual(gtd.normalizeContexts(['@a', '@a']), ['@a']);
});

test('gtdLabelForStatus cubre los cuatro estados accionables', () => {
  assert.equal(gtd.gtdLabelForStatus('next'), 'GTD: Next');
  assert.equal(gtd.gtdLabelForStatus('reference'), 'GTD: Reference');
  assert.equal(gtd.gtdLabelForStatus('inbox'), null);
  assert.equal(gtd.gtdLabelForStatus('done'), null);
});
