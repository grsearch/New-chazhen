'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');
const { compactDatabase } = require('../scripts/compact-event-window-db');

function trade(signature, receivedAtMs, pool = 'pool') {
  return {
    type: 'ammTrade', signature, eventIndex: 0, receivedAtMs,
    orderingConfidence: 'STRICT', side: 'BUY', mint: `mint-${pool}`, pool,
    solAmount: 1, tokenAmount: 10,
  };
}

test('database compactor preserves research results and only causal trade windows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdbr-compact-'));
  const sourcePath = path.join(directory, 'source.db');
  const destinationPath = path.join(directory, 'destination.db');
  try {
    const source = new ResearchStore({
      dbPath: sourcePath, flushMs: 60_000, batchMax: 1_000,
      storeTradeRawJson: true, maintenanceIntervalMs: 3_600_000,
    });
    source.db.prepare(`
      INSERT INTO dump_events(
        episode_id,mint,pool,detected_at_ms,ordering_confidence,
        matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
      ) VALUES('episode','mint-pool','pool',10000,'STRICT','[]','OBSERVING',0,10000)
    `).run();
    source.db.prepare(`
      INSERT INTO same_slot_shadow_simulations(
        shadow_id,episode_id,target_rank,position_sol,exit_horizon_ms,quote_model,status,
        infrastructure_mode,infrastructure_executable,infrastructure_reason,
        entry_assumption,entry_reference_rank,entry_at_ms,created_at_ms,updated_at_ms
      ) VALUES('shadow','episode',1,1,250,'V1','NO_EXIT','THEORETICAL_ONLY',0,
        'NO_GUARANTEE','THEORETICAL',0,10000,10000,12000)
    `).run();
    source.recordTrade(trade('inside-pre', 6_000));
    source.recordTrade(trade('inside-post', 20_000));
    source.recordTrade(trade('outside-time', 4_000));
    source.recordTrade(trade('outside-pool', 10_000, 'other'));
    source.close();

    const report = compactDatabase({ sourcePath, destinationPath });
    assert.equal(report.integrity, 'ok');

    const compact = new ResearchStore({
      dbPath: destinationPath, flushMs: 60_000, batchMax: 1_000,
      maintenanceIntervalMs: 3_600_000,
    });
    const rows = compact.db.prepare('SELECT signature,raw_json FROM trades ORDER BY signature').all();
    assert.deepEqual(rows, [
      { signature: 'inside-post', raw_json: null },
      { signature: 'inside-pre', raw_json: null },
    ]);
    assert.equal(compact.db.prepare('SELECT COUNT(*) count FROM dump_events').get().count, 1);
    assert.equal(
      compact.db.prepare('SELECT COUNT(*) count FROM same_slot_shadow_simulations').get().count,
      1,
    );
    compact.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
