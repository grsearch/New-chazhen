'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { PUMP_PARSE_VERSION } = require('../src/core/PumpEventParser');
const { exportResearchWindow } = require('../scripts/export-research-window');

test('daily export keeps a consistent 24-hour research window', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdbr-daily-export-'));
  const source = path.join(directory, 'source.db');
  const destination = path.join(directory, 'last24h.db');
  const schema = path.join(directory, 'schema.sql');
  const startMs = 1_000_000;
  const endMs = startMs + 86_400_000;
  const store = new ResearchStore({ dbPath: source, flushMs: 60_000, batchMax: 1_000 });
  store.close();

  const db = new Database(source);
  const trade = db.prepare(`
    INSERT INTO trades(received_at_ms,event_index,signature,ordering_confidence,side)
    VALUES(?,?,?,?,?)
  `);
  trade.run(startMs - 1, 0, 'old-trade', 'STRICT', 'BUY');
  trade.run(startMs, 0, 'inside-trade', 'STRICT', 'SELL');
  const slotSummary = db.prepare(`
    INSERT INTO slot_summaries(
      slot,first_received_at_ms,last_received_at_ms,event_count,transaction_count
    ) VALUES(?,?,?,?,?)
  `);
  slotSummary.run(10, startMs + 1_000, startMs + 2_000, 1, 1);
  slotSummary.run(11, startMs + 12_000, startMs + 13_000, 1, 1);

  const dump = db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,drop_pct,parse_version,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `);
  dump.run('old', 'old-mint', 'old-pool', startMs - 1, 'STRICT', '[]', 'EXPIRED', 0,
    20, PUMP_PARSE_VERSION, startMs - 1);
  dump.run('inside', 'mint', 'pool', startMs + 10, 'STRICT', '[]', 'CONFIRMED', 0,
    20, PUMP_PARSE_VERSION, startMs + 20);
  dump.run('legacy-parse', 'legacy-mint', 'legacy-pool', startMs + 11, 'STRICT', '[]',
    'EXPIRED', 0, 20, 'LEGACY', startMs + 21);
  dump.run('rug', 'rug-mint', 'rug-pool', startMs + 12, 'STRICT', '[]', 'EXPIRED', 0,
    60, PUMP_PARSE_VERSION, startMs + 22);

  const confirmation = db.prepare(`
    INSERT INTO confirmations(
      confirmation_id,episode_id,profile_id,confirmed_at_ms,ordering_confidence,snapshot_json
    ) VALUES(?,?,?,?,?,?)
  `);
  confirmation.run('old:R1', 'old', 'R1', startMs + 5, 'STRICT', '{}');
  confirmation.run('inside:DBM-S-D8', 'inside', 'DBM-S-D8', endMs + 5, 'STRICT', '{}');
  db.prepare(`
    INSERT INTO simulations(
      simulation_id,confirmation_id,episode_id,recovery_profile_id,entry_variant_id,
      entry_kind,entry_delay_ms,exit_profile_id,position_sol,quote_model,status,
      confirmed_at_ms,entry_at_ms,exit_at_ms,net_return_pct,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'inside:simulation', 'inside:DBM-S-D8', 'inside', 'DBM-S-D8', 'E0',
    'DELAY', 0, 'TP5-TR8D3-H30-SLN-X0', 1,
    'PUMPSWAP_DIRECT_DUMP_MANAGED_V3', 'CLOSED', endMs + 5, endMs + 10,
    endMs + 20, 1, endMs + 5, endMs + 20,
  );
  db.prepare(`
    INSERT INTO same_slot_observations(
      observation_id,episode_id,mint,pool,observed_at_ms,slot,event_index,
      classification,receive_lag_ms,buy_sol,executable,rejection_reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
  `).run(
    'inside:buy', 'inside', 'mint', 'pool', startMs + 11, 10, 0,
    'STRICT_AFTER_DUMP', 1, 0.5, 'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE',
  );
  db.prepare(`
    INSERT INTO same_slot_shadow_simulations(
      shadow_id,episode_id,target_rank,position_sol,exit_horizon_ms,quote_model,status,
      infrastructure_mode,infrastructure_executable,infrastructure_reason,
      entry_assumption,entry_reference_rank,entry_at_ms,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,'THEORETICAL_ONLY',0,?,'THEORETICAL',0,?,?,?)
  `).run(
    'inside:rank1', 'inside', 1, 1, 250, 'SAME_SLOT_V1', 'NO_EXIT',
    'POST_EXECUTION_STREAM_NO_LANDING_GUARANTEE', startMs + 10, startMs + 10, startMs + 20,
  );
  db.close();

  const result = exportResearchWindow({
    sourcePath: source, destinationPath: destination, startMs, endMs, schemaPath: schema,
  });
  assert.equal(result.formatVersion, 2);
  assert.equal(result.integrity, 'ok');
  assert.equal(result.analysisReadiness.schemaVersion, '13');
  assert.deepEqual(result.analysisReadiness.missingColumns, []);
  assert.equal(result.analysisReadiness.status, 'COLLECT_MORE_DATA');
  assert.equal(result.analysisReadiness.readinessVersion, 3);
  assert.equal(result.analysisReadiness.liveTradingDecision, 'TRADING_DISABLED');
  assert.equal(result.analysisReadiness.ingestion.tradeRowsByMode.UNKNOWN, 1);
  assert.equal(result.analysisReadiness.ingestion.dumpEpisodesByMode.UNKNOWN, 2);
  assert.equal(result.analysisReadiness.researchModel, 'PUMPSWAP_DIRECT_DUMP_MANAGED_V3');
  assert.equal(result.analysisReadiness.directDumpMatrix.qualifiedEpisodes, 1);
  assert.equal(result.analysisReadiness.directDumpMatrix.rows, 1);
  assert.equal(result.analysisReadiness.directDumpMatrix.expectedRows, 180);
  assert.ok(result.analysisReadiness.gates.some(
    (gate) => gate.id === 'DIRECT_V3_QUALIFIED_EPISODES',
  ));
  assert.ok(result.analysisReadiness.gates.every(
    (gate) => !gate.id.includes('SAME_SLOT') && !gate.id.includes('NEXT_SLOT')
      && !gate.id.includes('R2-ABS'),
  ));
  assert.equal(result.analysisReadiness.stream.maximumObservedGapMs, 10_000);
  assert.equal(result.analysisReadiness.stream.leadingGapMs, 1_000);
  assert.equal(result.analysisReadiness.stream.internalMissingMs, 5_000);
  assert.equal(result.analysisReadiness.stream.trailingGapMs, endMs - startMs - 13_000);
  assert.equal(result.analysisReadiness.stream.significantGapCount, 1);
  assert.equal(result.analysisReadiness.stream.coverageHours, 7_000 / 3_600_000);
  assert.equal(result.analysisReadiness.stream.observedSpanHours, 12_000 / 3_600_000);
  assert.ok(result.analysisReadiness.gates.some((gate) => !gate.passed));
  const exported = new Database(destination, { readonly: true, fileMustExist: true });
  assert.deepEqual(exported.prepare('SELECT signature FROM trades').all(), [{ signature: 'inside-trade' }]);
  assert.deepEqual(exported.prepare('SELECT episode_id FROM dump_events ORDER BY episode_id').all(), [
    { episode_id: 'inside' }, { episode_id: 'rug' },
  ]);
  assert.deepEqual(
    exported.prepare('SELECT confirmation_id FROM confirmations').all(),
    [{ confirmation_id: 'inside:DBM-S-D8' }],
    'confirmation follows the selected dump even when it closes just after the window boundary',
  );
  assert.equal(exported.prepare('SELECT COUNT(*) count FROM same_slot_observations').get().count, 1);
  assert.equal(
    exported.prepare('SELECT COUNT(*) count FROM same_slot_shadow_simulations').get().count, 1,
  );
  assert.deepEqual(exported.pragma('foreign_key_check'), []);
  exported.close();
  assert.match(fs.readFileSync(schema, 'utf8'), /same_slot_observations/);
  const original = new Database(source, { readonly: true });
  assert.equal(original.prepare('SELECT COUNT(*) count FROM trades').get().count, 2);
  original.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('COS systemd timer is pinned to 07:00 Beijing time', () => {
  const timer = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'post-dump-recovery-backup.timer'), 'utf8',
  );
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'post-dump-recovery-backup.service'), 'utf8',
  );
  const upload = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'export-last24h-cos.sh'), 'utf8',
  );
  const installer = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'install-daily-export.sh'), 'utf8',
  );
  assert.match(timer, /OnCalendar=\*-\*-\* 07:00:00 Asia\/Shanghai/);
  assert.doesNotMatch(timer, /08:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /ReadWritePaths=@INSTALL_DIR@\/data/);
  assert.match(upload, /SDBR_BACKUP_COS_BUCKET/);
  assert.match(upload, /FLOW_BACKUP_COS_BUCKET/);
  assert.match(upload, /schedule=07:00 Asia\/Shanghai/);
  assert.match(installer, /LEGACY_ENV_FILE="\/etc\/flow-acceleration\/backup-cos\.env"/);
  assert.match(installer, /INSTALL_DIR="\$\{1:-\/home\/ubuntu\/New-chazhen\}"/);
  assert.doesNotMatch(installer, /\/opt\/new-chazhen/);
  assert.ok(
    installer.indexOf('systemctl enable --now "$TIMER_NAME"')
      < installer.indexOf('systemctl disable --now "$LEGACY_TIMER"'),
    'the old 08:00 timer must remain until the new 07:00 timer is enabled',
  );
});
