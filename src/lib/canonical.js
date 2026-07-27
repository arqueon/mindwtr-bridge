'use strict';

// Derivado de vikunja-anytype-sync/src/canonical.js
// (commit 238f617f8e2149ab69e50d63af3201e3174673ac). Subconjunto sin las
// funciones de markdown/procedencia específicas de atvk.

const crypto = require('node:crypto');

function normalizeUtc(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Fecha inválida: ${value}`);
  }
  return parsed.toISOString();
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortRecursively(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortRecursively(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

module.exports = {
  normalizeUtc,
  sha256,
  stableStringify,
};
