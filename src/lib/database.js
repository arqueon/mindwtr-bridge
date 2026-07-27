'use strict';

// Derivado de vikunja-anytype-sync/src/database.js
// (commit 238f617f8e2149ab69e50d63af3201e3174673ac).

const { Pool } = require('pg');

function createPool(config) {
  const pool = new Pool({
    ...config,
    application_name: 'mindwtr-bridge',
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (error) => {
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      component: 'postgres-pool',
      message: error.message,
      at: new Date().toISOString(),
    })}\n`);
  });
  return pool;
}

async function withAdvisoryLock(pool, key, callback) {
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) {
      return { ok: true, status: 'skipped_locked' };
    }
    return await callback(client);
  } finally {
    if (acquired) {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [key],
      ).catch(() => {});
    }
    client.release();
  }
}

module.exports = {
  createPool,
  withAdvisoryLock,
};
