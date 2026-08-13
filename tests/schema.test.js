'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('el esquema inicial y la migración admiten description y sus orígenes', () => {
  for (const relative of ['db/migrations/001_initial.sql', 'db/migrations/003_description_state.sql']) {
    const sql = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(sql, /'description'/);
    assert.match(sql, /'vikunja_sanitized'/);
    assert.match(sql, /'mindwtr_local_preserved'/);
  }
});

test('la identidad puede cambiar de id Vikunja sin perder checkpoints', () => {
  const sql = fs.readFileSync(path.join(root, 'db/migrations/004_identity_rebind.sql'), 'utf8');
  assert.match(sql, /provenance_marker/);
  assert.match(sql, /ON UPDATE CASCADE/);
});

test('el carril v3 ya no necesita columnas Anytype para nuevas capturas', () => {
  const sql = fs.readFileSync(path.join(root, 'db/migrations/005_vikunja_only_capture.sql'), 'utf8');
  assert.match(sql, /anytype_space_id DROP NOT NULL/);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/bridge.json'), 'utf8'));
  assert.equal(Object.hasOwn(config, 'anytype_api_url'), false);
  assert.equal(Object.hasOwn(config, 'atvk_db_name'), false);
  assert.equal(fs.existsSync(path.join(root, 'src/anytype-client.js')), false);
});
