'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideFieldSync } = require('../src/lib/field-sync');

test('valores iguales → accept_common', () => {
  const decision = decideFieldSync({
    vikunjaValue: 'x', mindwtrValue: 'x', lastCommonValue: 'y', direction: 'bidirectional',
  });
  assert.equal(decision.action, 'accept_common');
});

test('sin last_common siembra desde Vikunja', () => {
  const decision = decideFieldSync({
    vikunjaValue: 'a', mindwtrValue: 'b', hasLastCommon: false, direction: 'bidirectional',
  });
  assert.equal(decision.action, 'write_mindwtr');
});

test('solo cambió Vikunja → write_mindwtr; solo Mindwtr → write_vikunja', () => {
  assert.equal(decideFieldSync({
    vikunjaValue: 'nuevo', mindwtrValue: 'común', lastCommonValue: 'común', direction: 'bidirectional',
  }).action, 'write_mindwtr');
  assert.equal(decideFieldSync({
    vikunjaValue: 'común', mindwtrValue: 'nuevo', lastCommonValue: 'común', direction: 'bidirectional',
  }).action, 'write_vikunja');
});

test('cambio simultáneo con vikunja_wins → write_mindwtr', () => {
  const decision = decideFieldSync({
    vikunjaValue: 'v', mindwtrValue: 'm', lastCommonValue: 'c',
    direction: 'bidirectional', conflictPolicy: 'vikunja_wins',
  });
  assert.equal(decision.action, 'write_mindwtr');
});

test('cambio simultáneo con manual → conflict', () => {
  const decision = decideFieldSync({
    vikunjaValue: 'v', mindwtrValue: 'm', lastCommonValue: 'c',
    direction: 'bidirectional', conflictPolicy: 'manual',
  });
  assert.equal(decision.action, 'conflict');
});

test('dirección bloqueada no escribe', () => {
  const decision = decideFieldSync({
    vikunjaValue: 'común', mindwtrValue: 'nuevo', lastCommonValue: 'común',
    direction: 'vikunja_to_mindwtr',
  });
  assert.equal(decision.action, 'noop');
});

test('arrays comparan por contenido estable', () => {
  const decision = decideFieldSync({
    vikunjaValue: ['@a', '@b'], mindwtrValue: ['@a', '@b'], lastCommonValue: [], direction: 'bidirectional',
  });
  assert.equal(decision.action, 'accept_common');
});
