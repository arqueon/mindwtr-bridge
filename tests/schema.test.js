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
