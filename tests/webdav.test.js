'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebdavClient, normalizeEtag } = require('../src/webdav-client');

test('normalizeEtag removes weak indicators, quotes, and compression suffixes', () => {
  assert.equal(normalizeEtag(null), null);
  assert.equal(normalizeEtag(''), null);
  assert.equal(normalizeEtag('"321931c426f85b0e9246f6c57422d5bb"'), '321931c426f85b0e9246f6c57422d5bb');
  assert.equal(normalizeEtag('W/"321931c426f85b0e9246f6c57422d5bb"'), '321931c426f85b0e9246f6c57422d5bb');
  assert.equal(normalizeEtag('W/"321931c426f85b0e9246f6c57422d5bb-gzip"'), '321931c426f85b0e9246f6c57422d5bb');
  assert.equal(normalizeEtag('"321931c426f85b0e9246f6c57422d5bb-br"'), '321931c426f85b0e9246f6c57422d5bb');
  assert.equal(normalizeEtag('"321931c426f85b0e9246f6c57422d5bb-deflate"'), '321931c426f85b0e9246f6c57422d5bb');
  assert.equal(normalizeEtag('321931c426f85b0e9246f6c57422d5bb-gzip'), '321931c426f85b0e9246f6c57422d5bb');
});

test('WebdavClient get prioritizes oc-etag and strips compression suffixes', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      assert.equal(opts.headers['accept-encoding'], 'identity');
      return {
        ok: true,
        status: 200,
        text: async () => '{"test": true}',
        headers: {
          get: (name) => {
            const h = {
              etag: 'W/"cloudflare-hash-gzip"',
              'oc-etag': '"nextcloud-raw-hash"',
            };
            return h[name.toLowerCase()] ?? null;
          },
        },
      };
    };

    const client = new WebdavClient({ url: 'http://example.test/data.json', username: 'u', password: 'p' });
    const res = await client.get();
    assert.equal(res.etag, 'nextcloud-raw-hash');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebdavClient putIfMatch sets If-Match with quotes and parses response oc-etag', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let sentHeaders;
    globalThis.fetch = async (url, opts) => {
      sentHeaders = opts.headers;
      return {
        ok: true,
        status: 204,
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'oc-etag') return '"updated-etag"';
            return null;
          },
        },
      };
    };

    const client = new WebdavClient({ url: 'http://example.test/data.json', username: 'u', password: 'p' });
    const res = await client.putIfMatch('{"tasks":[]}', 'my-clean-etag');
    assert.equal(sentHeaders['if-match'], '"my-clean-etag"');
    assert.equal(res.ok, true);
    assert.equal(res.etag, 'updated-etag');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
