#!/usr/bin/env node
'use strict';

// CLI del bridge: reconcile | dry-run | seed-labels | retire-task | verify

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPool } = require('./lib/database');
const { VikunjaClient } = require('./vikunja-client');
const { WebdavClient } = require('./webdav-client');
const { runCycle, findAnytypeRoot, buildSubtree } = require('./reconcile');
const gtd = require('./gtd-mapping');
const model = require('./mindwtr-model');

function maintenanceFilePath(environment = process.env) {
  return environment.ATVK_MAINTENANCE_FILE || '/run/atvk-maintenance/atvk-mindwtr.lock';
}

function maintenanceStatus(environment = process.env) {
  const file = maintenanceFilePath(environment);
  try {
    const reason = fs.readFileSync(file, 'utf8').trim();
    return {
      active: true,
      reason: reason || 'mantenimiento-controlado',
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { active: false, reason: null };
    throw error;
  }
}

function loadConfig() {
  const configPath = process.env.BRIDGE_CONFIG
    || path.join(__dirname, '..', 'config', 'bridge.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const secretsDir = path.isAbsolute(config.secrets_dir ?? '')
    ? config.secrets_dir
    : path.join(path.dirname(configPath), '..', config.secrets_dir ?? 'secrets');

  const readSecret = (name) => fs.readFileSync(path.join(secretsDir, name), 'utf8').trim();
  const [webdavUser, ...webdavPassParts] = readSecret('webdav-credentials').split(':');
  return {
    config,
    vikunjaToken: readSecret('vikunja-api-token'),
    webdavUser,
    webdavPass: webdavPassParts.join(':'),
    postgresUrl: readSecret('postgres-url'),
  };
}

function buildContext() {
  const { config, vikunjaToken, webdavUser, webdavPass, postgresUrl } = loadConfig();
  const pool = createPool({ connectionString: postgresUrl });
  const vikunja = new VikunjaClient({ baseUrl: config.vikunja_base_url, token: vikunjaToken });
  const webdav = new WebdavClient({ url: config.webdav_url, username: webdavUser, password: webdavPass });

  return { config, pool, vikunja, webdav };
}

function backupsDir(config) {
  return config.backups_dir || path.join(__dirname, '..', 'backups');
}

// Solo los respaldos que genera este modulo. El 2026-08-10 un directorio ajeno
// en backups/ (pre-safe-descriptions-...) hizo que unlinkSync lanzara EISDIR.
function listBackups(dir) {
  return fs.readdirSync(dir).filter((f) => /^data-.*\.json$/.test(f)).sort();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Respalda el estado leido antes de cualquier PUT.
// Omite la escritura si es identica al respaldo anterior: el ciclo corre cada
// ~3 min y el cuerpo casi nunca cambia (el 2026-08-25 habia 6144 copias de
// 183352 bytes exactos, 1.1 GB). Con force siempre escribe (retire-task).
function writeBackup(config, body, { force = false } = {}) {
  const dir = backupsDir(config);
  fs.mkdirSync(dir, { recursive: true });
  if (!force) {
    const previo = listBackups(dir).pop();
    if (previo) {
      try {
        if (sha256(fs.readFileSync(path.join(dir, previo))) === sha256(body)) return null;
      } catch (err) {
        // Si no se puede leer el anterior, respaldamos igual.
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(dir, `data-${stamp}.json`);
  fs.writeFileSync(destino, body);
  return destino;
}

// Limpieza de disco. NUNCA debe abortar el ciclo: que una rotacion fallida
// tumbara la reconciliacion 15 dias (2026-08-10 -> 2026-08-25) fue un problema
// de acoplamiento, no de unlink. Por eso no lanza y corre DESPUES de runCycle.
function rotateBackups(config, log = () => {}) {
  const dir = backupsDir(config);
  const horas = config.backup_retention_hours
    ?? (config.backup_retention_days ?? 14) * 24;
  const cutoff = Date.now() - horas * 3600 * 1000;
  let borrados = 0;
  try {
    for (const file of listBackups(dir)) {
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          borrados += 1;
        }
      } catch (err) {
        log(`rotacion: se omite ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    log(`rotacion: no se pudo listar ${dir}: ${err.message}`);
  }
  return borrados;
}

async function commandReconcile({ dryRun }) {
  const { config, pool, vikunja, webdav } = buildContext();
  try {
    // Backup del estado leído antes de cualquier posible PUT del ciclo.
    if (!dryRun) {
      const current = await webdav.get();
      writeBackup(config, current.body);
    }
    const result = await runCycle({
      config,
      pool,
      vikunja,
      webdav,
      dryRun,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'error') process.exitCode = 1;
    // Despues del ciclo y aislada: la limpieza no puede tumbar la reconciliacion.
    if (!dryRun) rotateBackups(config, (m) => process.stderr.write(`${m}\n`));
  } finally {
    await pool.end();
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
    writeBackup(config, fetched.body, { force: true });
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
  if (command === 'reconcile') {
    const maintenance = maintenanceStatus();
    if (maintenance.active) {
      process.stdout.write(JSON.stringify({
        ok: true,
        status: 'skipped_maintenance',
        vikunja_writes: 0,
        mindwtr_mutations: 0,
        reason: maintenance.reason,
      }, null, 2) + '\n');
      return undefined;
    }
  }
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

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  maintenanceFilePath,
  maintenanceStatus,
};
