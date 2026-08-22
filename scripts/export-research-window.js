'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PUMP_PARSE_VERSION } = require('../src/core/PumpEventParser');

const MAX_DUMP_DROP_PCT = Number(process.env.SDBR_MAX_DUMP_DROP_PCT || 40);

const EXPLICIT_FILTERS = Object.freeze({
  trades: {
    where: 'received_at_ms >= ? AND received_at_ms < ?',
    bind: (startMs, endMs) => [startMs, endMs],
  },
  slot_summaries: {
    where: 'last_received_at_ms >= ? AND last_received_at_ms < ?',
    bind: (startMs, endMs) => [startMs, endMs],
  },
  dump_events: {
    where: `detected_at_ms >= ? AND detected_at_ms < ?
      AND (drop_pct IS NULL OR drop_pct <= ?) AND parse_version = ?`,
    bind: (startMs, endMs) => [startMs, endMs, MAX_DUMP_DROP_PCT, PUMP_PARSE_VERSION],
  },
  confirmations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
  same_slot_observations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
  simulations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
});

const GENERIC_TIME_COLUMNS = [
  'received_at_ms', 'detected_at_ms', 'confirmed_at_ms', 'observed_at_ms',
  'created_at_ms', 'updated_at_ms', 'last_seen_at_ms',
];

function parseArgs(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, raw = 'true'] = item.slice(2).split('=', 2);
    values[key] = raw;
  }
  return values;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function chooseFilter(table, columns) {
  if (EXPLICIT_FILTERS[table]) return EXPLICIT_FILTERS[table];
  if (table === 'schema_meta' || table === 'toxic_wallets') {
    return { where: '1 = 1', bind: () => [], fullTable: true };
  }
  const anchor = GENERIC_TIME_COLUMNS.find((column) => columns.includes(column));
  if (!anchor) return { where: '1 = 1', bind: () => [], fullTable: true };
  return {
    where: `${quoteIdentifier(anchor)} >= ? AND ${quoteIdentifier(anchor)} < ?`,
    bind: (startMs, endMs) => [startMs, endMs],
  };
}

function indexCreateSql(name, sourceSql) {
  const match = sourceSql.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+/i);
  if (!match) throw new Error(`Cannot parse CREATE INDEX for ${name}`);
  return `CREATE ${match[1] || ''}INDEX main.${quoteIdentifier(name)} ${sourceSql.slice(match[0].length)}`;
}

function formatShanghai(timestampMs) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestampMs)).replace(' ', 'T') + '+08:00';
}

function writeSchema(databasePath, schemaPath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const sql = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
    `).all().map((row) => `${row.sql};`).join('\n\n');
    fs.writeFileSync(schemaPath, `${sql}\n`, { encoding: 'utf8', mode: 0o600 });
  } finally {
    db.close();
  }
}

function exportResearchWindow({ sourcePath, destinationPath, startMs, endMs, schemaPath = null }) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error('A valid startMs < endMs window is required');
  }
  if (source === destination) throw new Error('Export destination must differ from source database');
  if (!fs.existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`Export destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const db = new Database(destination, { timeout: 10_000 });
  const tables = [];
  let committed = false;
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = OFF');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.prepare('ATTACH DATABASE ? AS source').run(source);
    db.exec('BEGIN');
    db.prepare('SELECT COUNT(*) AS count FROM source.sqlite_master').get();

    const sourceTables = db.prepare(`
      SELECT name, sql FROM source.sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY CASE name
        WHEN 'schema_meta' THEN 1 WHEN 'trades' THEN 2 WHEN 'slot_summaries' THEN 3
        WHEN 'dump_events' THEN 4 WHEN 'confirmations' THEN 5
        WHEN 'same_slot_observations' THEN 6 WHEN 'simulations' THEN 7
        WHEN 'toxic_wallets' THEN 8 ELSE 20 END, name
    `).all();
    for (const table of sourceTables) {
      const columns = db.prepare(`PRAGMA source.table_info(${quoteIdentifier(table.name)})`)
        .all().map((column) => column.name);
      const filter = chooseFilter(table.name, columns);
      db.exec(table.sql);
      const result = db.prepare(`
        INSERT INTO main.${quoteIdentifier(table.name)}
        SELECT * FROM source.${quoteIdentifier(table.name)} WHERE ${filter.where}
      `).run(...filter.bind(startMs, endMs));
      tables.push({ table: table.name, rows: result.changes, fullTable: Boolean(filter.fullTable) });
    }

    const indexes = db.prepare(`
      SELECT name, sql FROM source.sqlite_master
      WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY name
    `).all();
    for (const index of indexes) db.exec(indexCreateSql(index.name, index.sql));
    db.exec('COMMIT');
    committed = true;
    db.exec('DETACH DATABASE source');
  } catch (error) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
    try { db.exec('DETACH DATABASE source'); } catch (_) {}
    try { fs.rmSync(destination, { force: true }); } catch (_) {}
    throw error;
  } finally {
    db.close();
  }

  const exported = new Database(destination, { readonly: true, fileMustExist: true });
  let integrity;
  try {
    integrity = exported.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Export integrity check failed: ${integrity}`);
  } finally {
    exported.close();
  }
  if (schemaPath) writeSchema(destination, path.resolve(schemaPath));

  return {
    formatVersion: 1,
    mode: 'CONSISTENT_READ_TRANSACTION_24H_WINDOW',
    createdAtMs: Date.now(),
    range: {
      startMs, endMs,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
      startCst: formatShanghai(startMs),
      endCst: formatShanghai(endMs),
    },
    source,
    destination,
    sourceBytes: fs.statSync(source).size,
    exportBytes: fs.statSync(destination).size,
    integrity,
    tables,
  };
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const source = input.db || process.env.SDBR_DB_PATH || './data/sdbr-research.db';
  const destination = input.out;
  if (!destination) throw new Error('--out=/path/to/export.db is required');
  const hours = Number(input.hours || 24);
  const endMs = input['end-ms'] ? Number(input['end-ms']) : Date.now();
  const startMs = input['start-ms'] ? Number(input['start-ms']) : endMs - hours * 3_600_000;
  const manifestPath = input.manifest || `${destination}.manifest.json`;
  const result = exportResearchWindow({
    sourcePath: source,
    destinationPath: destination,
    startMs,
    endMs,
    schemaPath: input.schema || null,
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[WindowExport] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { chooseFilter, exportResearchWindow, formatShanghai, parseArgs };
