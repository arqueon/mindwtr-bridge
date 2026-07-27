#!/usr/bin/env node
'use strict';

// CLI del bridge: reconcile | dry-run | seed-labels | retire-task | verify

const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('./lib/database');
const { AnytypeClient } = require('./anytype-client');
const { VikunjaClient } = require('./vikunja-client');
const { WebdavClient } = require('./webdav-client');
const { runCycle, findAnytypeRoot, buildSubtree } = require('./reconcile');
const gtd = require('./gtd-mapping');
const model = require('./mindwtr-model');

function loadConfig() {
  const configPath = process.env.BRIDGE_CONFIG
    || path.join(__dirname, '..', 'config', 'bridge.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const secretsDir = path.isAbsolute(config.secrets_dir ?? '')
    ? config.secrets_dir
    : path.join(path.dirname(configPath), '..', config.secrets_dir ?? 'secrets');

  const readSecret = (name) => fs.readFileSync(path.join(secretsDir, name), 'utf8').trim();
  const readOptionalSecret = (name) => {
    try {
      return readSecret(name);
    } catch {
      return null;
    }
  };

  const [webdavUser, ...webdavPassParts] = readSecret('webdav-credentials').split(':');
  return {
    config,
    vikunjaToken: readSecret('vikunja-api-token'),
    webdavUser,
    webdavPass: webdavPassParts.join(':'),
    postgresUrl: readSecret('postgres-url'),
    anytypeApiKey: readOptionalSecret('anytype-api-key'),
  };
}

function buildContext() {
  const { config, vikunjaToken, webdavUser, webdavPass, postgresUrl, anytypeApiKey } = loadConfig();
  const pool = createPool({ connectionString: postgresUrl });
  const vikunja = new VikunjaClient({ baseUrl: config.vikunja_base_url, token: vikunjaToken });
  const webdav = new WebdavClient({ url: config.webdav_url, username: webdavUser, password: webdavPass });

  // Carril de captura: requiere la API de Anytype y lectura-solo de la BD de
  // atvk. Si falta el secreto, el bridge opera sin captura (aviso, no error).
  let anytype = null;
  let atvkPool = null;
  if (config.enable_capture && anytypeApiKey) {
    anytype = new AnytypeClient({
      baseUrl: config.anytype_api_url,
      token: anytypeApiKey,
      version: config.anytype_api_version,
    });
    const atvkUrl = postgresUrl.replace(/\/[^/?]+(\?.*)?$/, `/${config.atvk_db_name ?? 'anytype_sync'}$1`);
    atvkPool = createPool({ connectionString: atvkUrl });
  } else if (config.enable_capture) {
    process.stderr.write('⚠ enable_capture sin secrets/anytype-api-key: carril de captura desactivado este ciclo.\n');
  }

  return { config, pool, vikunja, webdav, anytype, atvkPool };
}

function backupBody(config, body) {
  const dir = config.backups_dir || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `data-${stamp}.json`), body);
  const cutoff = Date.now() - (config.backup_retention_days ?? 14) * 24 * 3600 * 1000;
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
  }
}

async function commandReconcile({ dryRun }) {
  const { config, pool, vikunja, webdav, anytype, atvkPool } = buildContext();
  try {
    // Backup del estado leído antes de cualquier posible PUT del ciclo.
    if (!dryRun) {
      const current = await webdav.get();
      backupBody(config, current.body);
    }
    const result = await runCycle({
      config,
      pool,
      vikunja,
      webdav,
      anytype,
      atvkPool,
      dryRun,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'error') process.exitCode = 1;
  } finally {
    await pool.end();
    if (atvkPool) await atvkPool.end();
  }
}

async function commandSeedLabels() {
  const { config, pool, vikunja } = buildContext();
  try {
    const labels = await vikunja.listLabels();
    const byTitle = new Map(labels.map((label) => [gtd.normalizeLabelTitle(label.title).toLowerCase(), label]));
    for (const title of gtd.GTD_LABEL_TITLES) {
      let label = byTitle.get(title.toLowerCase());
      if (!label) {
        label = await vikunja.createLabel({ title, hex_color: 'a78bfa' });
        process.stdout.write(`creada: ${title} (#${label.id})\n`);
      } else {
        process.stdout.write(`existe: ${title} (#${label.id})\n`);
      }
    }
  } finally {
    await pool.end();
  }
}

// Revierte por completo una tarea piloto: quita labels GTD en Vikunja,
// elimina el espejo del data.json y limpia el mapeo.
async function commandRetireTask(taskIdRaw) {
  const taskId = Number(taskIdRaw);
  if (!Number.isInteger(taskId)) throw new Error('retire-task requiere el id numérico de la tarea Vikunja.');
  const { config, pool, vikunja, webdav } = buildContext();
  try {
    const mapping = (await pool.query('SELECT * FROM task_map WHERE vikunja_task_id = $1', [taskId])).rows[0];
    if (!mapping) {
      process.stdout.write('Sin mapeo; nada que retirar.\n');
      return;
    }
    const task = await vikunja.getTask(taskId);
    if (task) {
      const labels = await vikunja.listLabels();
      const gtdIds = labels
        .filter((label) => gtd.isGtdLabel(label.title))
        .map((label) => label.id);
      const attached = (task.labels ?? []).filter((label) => gtdIds.includes(label.id));
      for (const label of attached) {
        await vikunja.removeLabel(taskId, label.id);
        process.stdout.write(`label retirada de Vikunja: ${label.title}\n`);
      }
    }
    const fetched = await webdav.get();
    backupBody(config, fetched.body);
    const data = model.parseData(fetched.body);
    const index = data.tasks.findIndex((item) => item.id === mapping.mindwtr_task_id);
    if (index >= 0) {
      data.tasks.splice(index, 1);
      const result = await webdav.putIfMatch(model.serializeData(data), fetched.etag);
      if (result.conflict) throw new Error('PUT 412 al retirar; reintentar.');
      process.stdout.write('espejo eliminado del data.json\n');
    }
    await pool.query('DELETE FROM task_map WHERE vikunja_task_id = $1', [taskId]);
    process.stdout.write('mapeo eliminado\n');
  } finally {
    await pool.end();
  }
}

async function commandVerify() {
  const { config, pool, vikunja, webdav } = buildContext();
  try {
    const report = {};

    const projects = await vikunja.listProjects();
    const root = findAnytypeRoot(projects, config.root_project_title);
    const { containers, children } = buildSubtree(projects, root);
    let pending = 0;
    for (const container of containers) {
      const scoped = [container, ...(children.get(container.id) ?? [])];
      for (const project of scoped) {
        const tasks = await vikunja.listProjectTasks(project.id);
        pending += tasks.filter((task) => !task.done).length;
      }
    }
    report.vikunja_pending_under_root = pending;

    const counts = (await pool.query(
      'SELECT state, count(*)::int AS n FROM task_map GROUP BY state',
    )).rows;
    report.task_map = Object.fromEntries(counts.map((row) => [row.state, row.n]));

    const fetched = await webdav.get();
    const data = model.parseData(fetched.body);
    const mirrorIds = new Set(
      (await pool.query('SELECT mindwtr_task_id FROM task_map')).rows.map((row) => row.mindwtr_task_id),
    );
    report.mirrors_in_data_json = data.tasks.filter((task) => mirrorIds.has(task.id)).length;
    report.personal_tasks_untouched = data.tasks.filter((task) => !mirrorIds.has(task.id)).length;

    const lastRun = (await pool.query(
      'SELECT started_at, status, vikunja_writes, mindwtr_mutations FROM sync_run ORDER BY id DESC LIMIT 1',
    )).rows[0];
    report.last_run = lastRun ?? null;

    const openErrors = (await pool.query(
      "SELECT count(*)::int AS n FROM sync_error WHERE created_at > now() - interval '24 hours'",
    )).rows[0];
    report.errors_last_24h = openErrors.n;

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'reconcile':
      return commandReconcile({ dryRun: false });
    case 'dry-run':
      return commandReconcile({ dryRun: true });
    case 'seed-labels':
      return commandSeedLabels();
    case 'retire-task':
      return commandRetireTask(args[0]);
    case 'verify':
      return commandVerify();
    default:
      process.stderr.write('Uso: cli.js <reconcile|dry-run|seed-labels|retire-task <id>|verify>\n');
      process.exitCode = 2;
      return undefined;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
