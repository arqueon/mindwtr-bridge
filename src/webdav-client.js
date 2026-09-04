'use strict';

// Cliente WebDAV mínimo para el data.json de Mindwtr en Nextcloud.
// Lectura con captura de ETag y escritura condicional con If-Match: la app
// móvil/desktop escribe el mismo archivo, así que toda escritura del bridge
// debe fallar (412) si el archivo cambió desde la lectura del ciclo.

class WebdavError extends Error {
  constructor(message, { status, method }) {
    super(message);
    this.name = 'WebdavError';
    this.status = status;
    this.method = method;
  }
}

function normalizeEtag(raw) {
  if (!raw) return null;
  return raw
    .replace(/^W\//, '')
    .replace(/^"|"$/g, '')
    .replace(/-(?:gzip|br|deflate)$/, '');
}

class WebdavClient {
  constructor({ url, username, password, timeoutMs = 30_000 }) {
    this.url = url;
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.timeoutMs = timeoutMs;
  }

  async get() {
    const response = await fetch(this.url, {
      method: 'GET',
      headers: {
        authorization: this.auth,
        'accept-encoding': 'identity',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new WebdavError(`GET data.json respondió HTTP ${response.status}.`, {
        status: response.status,
        method: 'GET',
      });
    }
    const body = await response.text();
    return {
      body,
      etag: normalizeEtag(response.headers.get('oc-etag') || response.headers.get('etag')),
    };
  }

  async putIfMatch(body, etag) {
    if (!etag) throw new TypeError('putIfMatch requiere el ETag de la lectura previa');
    const response = await fetch(this.url, {
      method: 'PUT',
      headers: {
        authorization: this.auth,
        'content-type': 'application/json; charset=utf-8',
        'if-match': `"${etag}"`,
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 412) {
      return { ok: false, conflict: true, etag: null };
    }
    if (!response.ok) {
      throw new WebdavError(`PUT data.json respondió HTTP ${response.status}.`, {
        status: response.status,
        method: 'PUT',
      });
    }
    return {
      ok: true,
      conflict: false,
      etag: normalizeEtag(response.headers.get('oc-etag') || response.headers.get('etag')),
    };
  }
}

module.exports = { WebdavClient, WebdavError, normalizeEtag };
