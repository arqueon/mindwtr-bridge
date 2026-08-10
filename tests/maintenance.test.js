'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { maintenanceFilePath, maintenanceStatus } = require('../src/cli');

test('sin archivo compartido el bridge puede reconciliar', () => {
  const file = path.join(os.tmpdir(), 'mindwtr-maintenance-inexistente');
  assert.equal(maintenanceFilePath({ ATVK_MAINTENANCE_FILE: file }), file);
  assert.deepEqual(maintenanceStatus({ ATVK_MAINTENANCE_FILE: file }), {
    active: false,
    reason: null,
  });
});

test('el candado compartido bloquea el ciclo y conserva el motivo', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-maintenance-'));
  const file = path.join(directory, 'lock');
  try {
    fs.writeFileSync(file, 'despliegue-v7\n', { mode: 0o600 });
    assert.deepEqual(maintenanceStatus({ ATVK_MAINTENANCE_FILE: file }), {
      active: true,
      reason: 'despliegue-v7',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
