'use strict';

// Criterio de "fallo pasajero" en la lectura previa de data.json.
// Un 5xx/429/timeout/red se omite (el ciclo vuelve en ~3 min); un 401/403/404
// es configuracion rota y DEBE seguir tumbando la unidad para que se vea.

const test = require('node:test');
const assert = require('node:assert');
const { WebdavError } = require('../src/webdav-client');
const { esFalloPasajero } = require('../src/cli');

function webdav(status) {
  return new WebdavError(`GET data.json respondió HTTP ${status}.`, { status, method: 'GET' });
}

test('los 5xx son pasajeros: se omite el ciclo', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(esFalloPasajero(webdav(status)), true, `HTTP ${status}`);
  }
});

test('429 es pasajero', () => {
  assert.equal(esFalloPasajero(webdav(429)), true);
});

test('los 4xx de configuracion NO son pasajeros: la unidad debe fallar', () => {
  for (const status of [400, 401, 403, 404, 409, 412]) {
    assert.equal(esFalloPasajero(webdav(status)), false, `HTTP ${status}`);
  }
});

test('timeout y abort son pasajeros', () => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(esFalloPasajero(timeout), true);

  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  assert.equal(esFalloPasajero(abort), true);
});

test('el fallo de red de undici es pasajero', () => {
  assert.equal(esFalloPasajero(new TypeError('fetch failed')), true);
});

test('un error cualquiera NO es pasajero', () => {
  assert.equal(esFalloPasajero(new Error('boom')), false);
  assert.equal(esFalloPasajero(new TypeError('x is not a function')), false);
  assert.equal(esFalloPasajero(null), false);
  assert.equal(esFalloPasajero(undefined), false);
});
