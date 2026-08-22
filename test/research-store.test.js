'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');

function storedTrade(signature, receivedAtMs) {
  return {
    type: 'ammTrade', signature, eventIndex: 0, receivedAtMs,
    orderingConfidence: 'STRICT', side: 'BUY', market: 'PUMP_AMM',
    mint: 'mint', pool: 'pool', solAmount: 1, tokenAmount: 10,
  };
}

test('trade rows omit duplicate raw JSON and old event windows are pruned in bounded batches', () => {
  const now = 100_000;
  const store = new ResearchStore({
    dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000,
    storeTradeRawJson: false, tradeRetentionMs: 1_000,
    slotSummaryRetentionMs: 1_000, maintenanceIntervalMs: 60_000,
    maintenanceBatchMax: 1,
  });
  store.recordTrade(storedTrade('old-1', now - 2_000));
  store.recordTrade(storedTrade('old-2', now - 1_500));
  store.recordTrade(storedTrade('current', now));
  store.recordSlotSummary({
    slot: 1, firstReceivedAtMs: now - 2_000, lastReceivedAtMs: now - 2_000,
    eventCount: 1, transactionCount: 1, transactionIndexCoveragePct: 100,
    strictOrderingAvailable: true,
  });
  store.flush();

  const raw = store.db.prepare('SELECT raw_json FROM trades WHERE signature = ?').get('current');
  assert.equal(raw.raw_json, null);
  assert.deepEqual(store.maintain(now), { prunedTrades: 1, prunedSlotSummaries: 1 });
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM trades').get().count, 2);
  assert.equal(store.health().storageMode, 'DUMP_EVENT_WINDOWS');
  assert.equal(store.health().prunedTrades, 1);
  store.close();
});

test('research store batches events and reports NO_EXIT independently', () => {
  const now = 1_800_000_000_000;
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  const dump = {
    episodeId: 'episode', mint: 'mint', pool: 'pool', seller: 'seller', coinCreator: 'creator',
    detectedAtMs: now, chainTimestampMs: now - 10, slot: 100, transactionIndex: 1,
    instructionIndex: 0, eventIndex: 0, signature: 'dump', orderingConfidence: 'STRICT',
    matchedDumpProfiles: ['D'], sellSol: 10, sellTokens: 100, prePrice: 10,
    prePriceSource: 'PREVIOUS_PUBLIC_TRADE', postPrice: 7, lowPrice: 7, dropPct: 30,
    preQuoteSol: 100, postQuoteSol: 90, sellToQuotePct: 10,
    sellTokenToReservePct: 5, poolAgeMs: 100_000, poolAgeSource: 'MIGRATION_EVENT',
    preWindow: { trades: 10, buySol: 5, sellSol: 1, netFlowSol: 4, buySharePct: 80,
      uniqueBuyers: 5, largestBuyerSharePct: 30, priceRunupPct: 20 },
  };
  store.insertDump(dump, { rejected: false, reasons: [], unavailableChecks: [] });
  store.updateDump({
    episodeId: 'episode', status: 'CONFIRMED', observedAtMs: now + 100,
    validBuySol: 2, rawBuySol: 2, followSellSol: 0, uniqueBuyers: 3,
    buyToDumpPct: 20, priceBouncePct: 6, maxRecoveryPct: 30,
    currentQuoteSol: 95, quoteRetentionPct: 105, strictSameSlotBuys: 1,
    correlatedSameSlotBuys: 0, secondDump: false, confirmedProfiles: ['R1'],
    survival1s: 1,
  });
  const snapshot = {
    slotDelta: 1, currentPrice: 8, lowPrice: 7, priceBouncePct: 14,
    dropRecoveryPct: 33, validBuySol: 2, uniqueBuyers: 3, buyToDumpPct: 20,
    netFlowSol: 2, netFlow1sSol: 1, netFlow3sSol: 2, currentQuoteSol: 95,
  };
  store.insertConfirmation({
    confirmationId: 'episode:R1', episodeId: 'episode', profileId: 'R1',
    confirmedAtMs: now + 100, slot: 101, transactionIndex: 1, instructionIndex: 0,
    eventIndex: 0, signature: 'confirm', orderingConfidence: 'STRICT', snapshot,
  });
  store.insertConfirmation({
    confirmationId: 'episode:R2', episodeId: 'episode', profileId: 'R2',
    confirmedAtMs: now + 110, slot: 101, transactionIndex: 2, instructionIndex: 0,
    eventIndex: 0, signature: 'confirm-r2', orderingConfidence: 'STRICT', snapshot,
  });
  store.insertSameSlotObservation({
    observationId: 'episode:same-slot:0', episodeId: 'episode', mint: 'mint', pool: 'pool',
    observedAtMs: now + 50, slot: 100, dumpTransactionIndex: 1, buyTransactionIndex: 2,
    instructionIndex: 0, eventIndex: 0, signature: 'same-slot', wallet: 'buyer',
    classification: 'STRICT_AFTER_DUMP', receiveLagMs: 50, buySol: 0.5,
    price: 7.5, priceBouncePct: 7.14, executable: true,
    rejectionReason: 'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE',
  });
  const baseSimulation = {
    confirmationId: 'episode:R1', episodeId: 'episode', recoveryProfileId: 'R1',
    entryVariantId: 'E200', entryKind: 'DELAY', entryDelayMs: 200,
    exitProfileId: 'H1', positionSol: 1, quoteModel: 'TEST',
    confirmedAtMs: now + 100, confirmationSlot: 101, requestedEntryAtMs: now + 300,
    entryDeadlineAtMs: now + 2_100, entryFeeSol: 0, exitFeeSol: 0,
    failedTransactionFeeSol: 0, createdAtMs: now, updatedAtMs: now + 500,
  };
  store.insertSimulation({
    ...baseSimulation, simulationId: 'closed', status: 'CLOSED', entryAtMs: now + 400,
    exitAtMs: now + 1_500, entryPrice: 1, exitPrice: 1.1, netReturnPct: 10,
    entryCapacityRoundTripLossPct: 2.5, entryCapacityExitLiquidityUsagePct: 1.2,
  });
  store.insertSimulation({
    ...baseSimulation, simulationId: 'no-exit', status: 'NO_EXIT', entryAtMs: now + 400,
    rejectionReason: 'NO_CAUSAL_EXIT_QUOTE',
  });
  store.insertSimulation({
    ...baseSimulation, simulationId: 'no-trade-after-horizon', status: 'NO_EXIT',
    entryAtMs: now + 400, rejectionReason: 'NO_TRADE_AT_OR_AFTER_EXIT_HORIZON',
  });
  store.flush();
  const summary = store.summary();
  assert.equal(summary.dumps.independent, 1);
  assert.equal(summary.dumps.nextSlotRecoveryRatePct, 100);
  assert.equal(summary.sameSlotProbe.observations, 1);
  assert.equal(summary.sameSlotProbe.strictAfterDumpBuys, 1);
  assert.equal(summary.sameSlotProbe.executableSignals, 0, 'store must force probe rows to non-executable');
  assert.equal(summary.execution.scheduled, 3);
  assert.equal(summary.execution.exitFilled, 1);
  assert.equal(summary.execution.noExit, 2);
  assert.equal(summary.execution.resolved, 1, 'NO_EXIT must not be converted into an invented return');
  assert.equal(summary.execution.resolvedEpisodes, 1);
  assert.equal(summary.execution.episodesWithAnyWin, 1);
  assert.equal(summary.execution.largestWinnerEventContributionPct, 100);
  assert.equal(summary.execution.totalConfirmations, 2);
  assert.equal(summary.execution.confirmationsWithSimulation, 1);
  assert.equal(summary.execution.confirmationsWithoutSimulation, 1);
  assert.equal(summary.execution.confirmationCoveragePct, 50);
  assert.equal(summary.cohorts[0].quoteModel, 'TEST');
  assert.equal(summary.cohorts[0].resolved, 1);
  assert.equal(summary.cohorts[0].resolvedEpisodes, 1);
  assert.equal(summary.cohorts[0].noExitQuote, 1);
  assert.equal(summary.cohorts[0].noTradeAfterHorizon, 1);
  assert.equal(summary.cohorts[0].noExitOther, 0);
  const storedCapacity = store.db.prepare(`
    SELECT entry_capacity_round_trip_loss_pct loss,
      entry_capacity_exit_liquidity_usage_pct exit_usage
    FROM simulations WHERE simulation_id='closed'
  `).get();
  assert.deepEqual(storedCapacity, { loss: 2.5, exit_usage: 1.2 });
  store.close();
});

test('recent dumps use bounded server-side pagination', () => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  const insert = store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES(?,?,?,?,?,'[]','OBSERVING',0,?)
  `);
  for (let index = 0; index < 25; index += 1) {
    insert.run(
      `episode-${index}`, `mint-${index}`, `pool-${index}`,
      1_000 + index, 'STRICT', 1_000 + index,
    );
  }
  const first = store.recentDumpsPage(1, 10);
  const last = store.recentDumpsPage(3, 10);
  assert.equal(first.total, 25);
  assert.equal(first.totalPages, 3);
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].episode_id, 'episode-24');
  assert.equal(last.items.length, 5);
  assert.equal(last.items.at(-1).episode_id, 'episode-0');
  const bounded = store.recentDumpsPage(99, 1_000);
  assert.equal(bounded.pageSize, 100);
  assert.equal(bounded.page, 1);
  store.close();
});

test('recent same-slot observations use bounded server-side pagination', () => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  const insertDump = store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES(?,?,?,?,?,'[]','OBSERVING',0,?)
  `);
  const insertObservation = store.db.prepare(`
    INSERT INTO same_slot_observations(
      observation_id,episode_id,mint,pool,observed_at_ms,slot,event_index,
      classification,receive_lag_ms,buy_sol,executable,rejection_reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
  `);
  for (let index = 0; index < 25; index += 1) {
    insertDump.run(
      `episode-${index}`, `mint-${index}`, `pool-${index}`,
      1_000 + index, 'STRICT', 1_000 + index,
    );
    insertObservation.run(
      `observation-${index}`, `episode-${index}`, `mint-${index}`, `pool-${index}`,
      1_000 + index, index, 0, 'STRICT_AFTER_DUMP', 10, 1,
      'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE',
    );
  }
  const first = store.recentSameSlotObservationsPage(1, 10);
  const last = store.recentSameSlotObservationsPage(3, 10);
  assert.equal(first.total, 25);
  assert.equal(first.totalPages, 3);
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].observation_id, 'observation-24');
  assert.equal(last.items.length, 5);
  assert.equal(last.items.at(-1).observation_id, 'observation-0');
  const bounded = store.recentSameSlotObservationsPage(99, 1_000);
  assert.equal(bounded.pageSize, 100);
  assert.equal(bounded.page, 1);
  store.close();
});

test('obsolete small-position simulations can be removed without deleting current positions', () => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES('episode','mint','pool',1,'STRICT','[]','CONFIRMED',0,1)
  `).run();
  store.db.prepare(`
    INSERT INTO confirmations(
      confirmation_id,episode_id,profile_id,confirmed_at_ms,ordering_confidence,snapshot_json
    ) VALUES('confirmation','episode','R1',1,'STRICT','{}')
  `).run();
  const insert = store.db.prepare(`
    INSERT INTO simulations(
      simulation_id,confirmation_id,episode_id,recovery_profile_id,entry_variant_id,
      entry_kind,entry_delay_ms,exit_profile_id,position_sol,quote_model,status,
      confirmed_at_ms,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const positionSol of [0.02, 0.05, 0.1, 1, 2, 5]) {
    insert.run(
      `simulation-${positionSol}`, 'confirmation', 'episode', 'R1', 'E100',
      'DELAY', 100, 'H1', positionSol, 'TEST', 'NO_ENTRY', 1, 1, 1,
    );
  }

  const removed = store.deleteSimulationsByPositionSizes([0.02, 0.05, 0.1]);
  const remaining = store.db.prepare('SELECT position_sol FROM simulations ORDER BY position_sol')
    .all().map((row) => row.position_sol);

  assert.equal(removed, 3);
  assert.deepEqual(remaining, [1, 2, 5]);
  assert.deepEqual(store.summary().cohorts.map((row) => row.positionSol), [1, 2, 5]);
  store.close();
});

test('invalid V1/V2 simulations can be removed without deleting V3 research data', () => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES('episode','mint','pool',1,'STRICT','[]','CONFIRMED',0,1)
  `).run();
  store.db.prepare(`
    INSERT INTO confirmations(
      confirmation_id,episode_id,profile_id,confirmed_at_ms,ordering_confidence,snapshot_json
    ) VALUES('confirmation','episode','R1',1,'STRICT','{}')
  `).run();
  const insert = store.db.prepare(`
    INSERT INTO simulations(
      simulation_id,confirmation_id,episode_id,recovery_profile_id,entry_variant_id,
      entry_kind,entry_delay_ms,exit_profile_id,position_sol,quote_model,status,
      confirmed_at_ms,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insert.run(
    'v1', 'confirmation', 'episode', 'R1', 'E100', 'DELAY', 100, 'H1', 1,
    'PUMPSWAP_CPMM_EVENT_FEES_V1', 'NO_ENTRY', 1, 1, 1,
  );
  insert.run(
    'v2', 'confirmation', 'episode', 'R1', 'E100', 'DELAY', 100, 'H1', 1,
    'PUMPSWAP_CPMM_EXECUTABLE_FEES_V2', 'NO_ENTRY', 1, 1, 1,
  );
  insert.run(
    'v3', 'confirmation', 'episode', 'R1', 'E100', 'DELAY', 100, 'H1', 1,
    'PUMPSWAP_CPMM_CAUSAL_CAPACITY_V3', 'NO_ENTRY', 1, 1, 1,
  );

  const removed = store.deleteSimulationsByQuoteModels([
    'PUMPSWAP_CPMM_EVENT_FEES_V1', 'PUMPSWAP_CPMM_EXECUTABLE_FEES_V2',
  ]);
  const remaining = store.db.prepare('SELECT simulation_id FROM simulations').all();

  assert.equal(removed, 2);
  assert.deepEqual(remaining, [{ simulation_id: 'v3' }]);
  store.close();
});
