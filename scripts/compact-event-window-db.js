'use strict';

const fs = require('fs');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positiveInteger(name, fallback) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function quoted(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) throw new Error(`Unsafe identifier: ${identifier}`);
  return `"${identifier}"`;
}

function columns(db, schema, table) {
  return db.prepare(`PRAGMA ${quoted(schema)}.table_info(${quoted(table)})`)
    .all().map((row) => row.name);
}

function tableExists(db, schema, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM ${quoted(schema)}.sqlite_master WHERE type='table' AND name=?
  `).get(table));
}

function copyTable(db, table) {
  const destination = columns(db, 'main', table);
  const source = new Set(columns(db, 'source', table));
  const common = destination.filter((column) => source.has(column));
  const list = common.map(quoted).join(',');
  return db.prepare(`
    INSERT OR IGNORE INTO main.${quoted(table)} (${list})
    SELECT ${list} FROM source.${quoted(table)}
  `).run().changes;
}

function compactDatabase({ sourcePath, destinationPath, preWindowMs = 5_000, postWindowMs = 60_000 }) {
  sourcePath = path.resolve(sourcePath);
  destinationPath = path.resolve(destinationPath);
  if (sourcePath === destinationPath) throw new Error('source and destination must be different files');
  if (!fs.existsSync(sourcePath)) throw new Error(`source database does not exist: ${sourcePath}`);
  if (fs.existsSync(destinationPath)) {
    throw new Error(`destination already exists and will not be overwritten: ${destinationPath}`);
  }

  const store = new ResearchStore({
    dbPath: destinationPath,
    flushMs: 60_000,
    batchMax: 10_000,
    maintenanceIntervalMs: 3_600_000,
  });
  const db = store.db;
  try {
    db.prepare('ATTACH DATABASE ? AS source').run(sourcePath);
    const copied = {};
    const migrate = db.transaction(() => {
      for (const table of [
        'dump_events', 'confirmations', 'same_slot_observations',
        'same_slot_shadow_simulations', 'simulations', 'toxic_wallets',
        'watched_wallet_trades',
      ]) {
        copied[table] = tableExists(db, 'source', table) ? copyTable(db, table) : 0;
      }

      const destinationColumns = columns(db, 'main', 'trades');
      const sourceColumns = new Set(columns(db, 'source', 'trades'));
      const insertColumns = destinationColumns.filter((column) => sourceColumns.has(column));
      const selectColumns = insertColumns.map((column) => (
        column === 'raw_json' ? 'NULL' : `t.${quoted(column)}`
      ));
      copied.trades = db.prepare(`
        INSERT OR IGNORE INTO main.trades (${insertColumns.map(quoted).join(',')})
        SELECT ${selectColumns.join(',')}
        FROM source.dump_events d
        JOIN source.trades t ON t.pool = d.pool
          AND t.received_at_ms BETWEEN d.detected_at_ms - ? AND d.detected_at_ms + ?
      `).run(preWindowMs, postWindowMs).changes;

      const destinationSlots = columns(db, 'main', 'slot_summaries');
      const sourceSlots = new Set(columns(db, 'source', 'slot_summaries'));
      const slotColumns = destinationSlots.filter((column) => sourceSlots.has(column));
      copied.slot_summaries = db.prepare(`
        INSERT OR IGNORE INTO main.slot_summaries (${slotColumns.map(quoted).join(',')})
        SELECT ${slotColumns.map((column) => `s.${quoted(column)}`).join(',')}
        FROM source.slot_summaries s
        WHERE EXISTS (SELECT 1 FROM main.trades t WHERE t.slot = s.slot)
      `).run().changes;
    });
    migrate();
    const foreignKeyViolations = db.pragma('foreign_key_check');
    if (foreignKeyViolations.length) {
      throw new Error(`compacted database has ${foreignKeyViolations.length} foreign-key violations`);
    }
    const integrity = db.pragma('quick_check')[0]?.quick_check;
    if (integrity !== 'ok') throw new Error(`compacted database integrity check failed: ${integrity}`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.prepare('DETACH DATABASE source').run();
    const sourceBytes = fs.statSync(sourcePath).size;
    const destinationBytes = fs.statSync(destinationPath).size;
    return {
      sourcePath,
      destinationPath,
      preWindowMs,
      postWindowMs,
      copied,
      sourceBytes,
      destinationBytes,
      integrity,
      reductionPct: sourceBytes > 0 ? (1 - destinationBytes / sourceBytes) * 100 : null,
    };
  } finally {
    store.close();
  }
}

function main() {
  const sourcePath = argument('source');
  const destinationPath = argument('destination');
  if (!sourcePath || !destinationPath) {
    throw new Error('Usage: node scripts/compact-event-window-db.js --source OLD.db --destination NEW.db');
  }
  const result = compactDatabase({
    sourcePath,
    destinationPath,
    preWindowMs: positiveInteger('pre-ms', 5_000),
    postWindowMs: positiveInteger('post-ms', 60_000),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { compactDatabase };
