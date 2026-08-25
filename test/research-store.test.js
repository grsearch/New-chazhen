'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchStore, shadowScenarioStats } = require('../src/data/ResearchStore');

function storedTrade(signature, receivedAtMs) {
  return {
    type: 'ammTrade', signature, eventIndex: 0, receivedAtMs,
    orderingConfidence: 'STRICT', side: 'BUY', market: 'PUMP_AMM',
    mint: 'mint', pool: 'pool', solAmount: 1, tokenAmount: 10,
  };
}

test('Same-Slot scenarios include NO_EXIT loss and Jito tip sensitivity', () => {
  const stats = shadowScenarioStats({
    closedRows: [{ net_return_pct: 5, position_sol: 1, modeled_jito_tip_sol: 0 }],
    noExit: 1,
    noExitLossPcts: [-15, -100],
    jitoTipScenariosSol: [0.01],
  });
  assert.equal(stats.noExitScenarios[0].averageNetReturnPct, -5);
  assert.equal(stats.noExitScenarios[1].averageNetReturnPct, -47.5);
  assert.equal(stats.jitoTipScenarios[0].averageNetReturnPct, 3);
});

test('schema V10 reclassifies pre-existing B5 discovery rows without mixing holdout data', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdbr-b5-migration-'));
  const dbPath = path.join(directory, 'research.db');
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = new ResearchStore({ dbPath, flushMs: 60_000, batchMax: 1_000 });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES('discovery','mint','pool',1,'STRICT','[]','OBSERVING',0,1)
  `).run();
  store.db.prepare(`
    INSERT INTO same_slot_shadow_simulations(
      shadow_id,episode_id,target_rank,entry_profile_id,position_sol,exit_horizon_ms,
      quote_model,status,infrastructure_mode,infrastructure_executable,
      infrastructure_reason,data_quality_status,entry_assumption,entry_reference_rank,
      entry_at_ms,trigger_buy_sol,created_at_ms,updated_at_ms
    ) VALUES('old-b2','discovery',2,'R2-B2',1,500,'SHADOW_V2','CLOSED',
      'THEORETICAL_ONLY',0,'TEST','TRUSTED','THEORETICAL',1,1,6,1,1)
  `).run();
  store.close();

  store = new ResearchStore({
    dbPath, flushMs: 60_000, batchMax: 1_000, sameSlotStrongTriggerBuySol: 5,
  });
  const migrated = store.db.prepare(`
    SELECT entry_profile_id,cohort_stage FROM same_slot_shadow_simulations
    WHERE shadow_id='old-b2'
  `).get();
  assert.deepEqual(migrated, {
    entry_profile_id: 'R2-B5', cohort_stage: 'DISCOVERY_RECLASSIFIED_20260824',
  });
  store.close();
});

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
  assert.equal(summary.sameSlotProbe.rank1Buys, 1);
  assert.equal(summary.sameSlotProbe.rank2Buys, 0);
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

test('same-slot observations expose strict post-dump chain rank', () => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES('ranked','mint','pool',1,'STRICT','[]','OBSERVING',0,1)
  `).run();
  const insert = store.db.prepare(`
    INSERT INTO same_slot_observations(
      observation_id,episode_id,mint,pool,observed_at_ms,slot,
      dump_transaction_index,buy_transaction_index,instruction_index,event_index,
      classification,receive_lag_ms,buy_sol,executable,rejection_reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
  `);
  insert.run('later-received-first', 'ranked', 'mint', 'pool', 20, 10, 5, 9, 0, 0,
    'STRICT_AFTER_DUMP', 20, 1, 'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE');
  insert.run('chain-first', 'ranked', 'mint', 'pool', 30, 10, 5, 6, 0, 0,
    'STRICT_AFTER_DUMP', 30, 1, 'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE');
  const page = store.recentSameSlotObservationsPage(1, 20);
  const ranks = Object.fromEntries(page.items.map((row) => [row.observation_id, row.post_dump_buy_rank]));
  assert.deepEqual(ranks, { 'chain-first': 1, 'later-received-first': 2 });
  const summary = store.summary();
  assert.equal(summary.sameSlotProbe.rank1Buys, 1);
  assert.equal(summary.sameSlotProbe.rank2Buys, 1);
  assert.equal(summary.sameSlotProbe.eventsWithTop2Buys, 1);
  assert.equal(summary.sameSlotProbe.rank2ReceiveLagP50Ms, 20);
  assert.equal(summary.sameSlotProbe.rank2InterBuyGapP50Ms, -10);
  store.close();
});

test('quarantined same-slot observations remain stored but do not pollute dashboard statistics', () => {
  const store = new ResearchStore({
    dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000, sameSlotMaxTradeSol: 1_000,
  });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES('quality','mint','pool',1,'STRICT','[]','OBSERVING',0,1)
  `).run();
  const base = {
    episodeId: 'quality', mint: 'mint', pool: 'pool', observedAtMs: 2, slot: 1,
    eventIndex: 0, classification: 'STRICT_AFTER_DUMP', receiveLagMs: 1,
    price: 1, priceBouncePct: 1, wallet: null,
    rejectionReason: 'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE',
  };
  store.insertSameSlotObservation({
    ...base, observationId: 'trusted', signature: 'trusted', buySol: 5,
    dataQualityStatus: 'TRUSTED', dataQualityReasons: [],
  });
  store.insertSameSlotObservation({
    ...base, observationId: 'quarantined', signature: 'quarantined', buySol: 2_000,
    dataQualityStatus: 'QUARANTINED', dataQualityReasons: ['TRADE_SOL_ABOVE_LIMIT'],
  });
  store.insertSameSlotObservation({
    ...base, observationId: 'price-outlier', signature: 'price-outlier', buySol: 1,
    priceBouncePct: 10_000, dataQualityStatus: 'QUARANTINED',
    dataQualityReasons: ['OBSERVATION_PRICE_BOUNCE_ABOVE_LIMIT'],
  });
  store.flush();

  const summary = store.summary();
  assert.equal(summary.sameSlotProbe.observations, 1);
  assert.equal(summary.sameSlotProbe.averageBuySol, 5);
  assert.equal(summary.sameSlotProbe.dataQualityQuarantined, 2);
  assert.equal(store.recentSameSlotObservationsPage(1, 20).total, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM same_slot_observations').get().count, 3);
  const quarantined = store.db.prepare(`
    SELECT data_quality_reasons_json FROM same_slot_observations
    WHERE observation_id='quarantined'
  `).get();
  assert.equal(quarantined.data_quality_reasons_json, '["TRADE_SOL_ABOVE_LIMIT"]');
  store.close();
});

test('Same-Slot Shadow results persist separately and report rank cohorts', () => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,drop_pct,updated_at_ms
    ) VALUES('shadow-episode','mint','pool',1000,'STRICT','[]','OBSERVING',0,20,1000)
  `).run();
  const base = {
    episodeId: 'shadow-episode', positionSol: 1, exitHorizonMs: 250,
    quoteModel: 'SAME_SLOT_V1', infrastructureMode: 'THEORETICAL_ONLY',
    infrastructureExecutable: false,
    infrastructureReason: 'POST_EXECUTION_STREAM_NO_LANDING_GUARANTEE',
    parseBudgetMs: 2, buildBudgetMs: 5, signBudgetMs: 1, sendBudgetMs: 15,
    responseBudgetMs: 23, competitorObservedAtMs: 1020, competitorReceiveLagMs: 20,
    latencyModel: 'ENTRY_REFERENCE_TO_NEXT_COMPETITOR_V2', competitorReferenceAtMs: 1000,
    competitorGapMs: 20, competitorHeadroomMs: -3, entryProfileId: 'R1-RAW',
    dataQualityStatus: 'TRUSTED', dataQualityReasons: [], modeledJitoTipSol: 0.005,
    entryAssumption: 'THEORETICAL', entryReferenceRank: 0,
    entryAtMs: 1000, entrySlot: 10, entryReferenceSignature: 'dump',
    entryReferenceTransactionIndex: 1, entryReferenceInstructionIndex: 0,
    entryReferenceEventIndex: 0, entryPrice: 1, entryMarketPrice: 1,
    entryImpactPct: 0, entryTotalFeeBps: 25, entryLiquidityUsagePct: 1,
    entryCapacityRoundTripLossPct: 2, entryCapacityExitLiquidityUsagePct: 1,
    tokenUnits: 1, entryReserveSource: 'TEST', entryFeeSol: 0.001, exitFeeSol: 0.001,
    requestedExitAtMs: 1250, exitDeadlineAtMs: 3250, postHorizonTrades: 1,
    createdAtMs: 1000, updatedAtMs: 1300,
  };
  store.insertSameSlotShadow({
    ...base, shadowId: 'rank-1', targetRank: 1, status: 'CLOSED',
    exitReason: 'PRIMARY',
    exitAtMs: 1300, exitSlot: 11, exitSignature: 'exit', exitQuoteLagMs: 50,
    exitPrice: 1.1, exitMarketPrice: 1.1, exitImpactPct: 0, exitTotalFeeBps: 25,
    exitLiquidityUsagePct: 1, exitReserveSource: 'TEST', proceedsSol: 1.1,
    totalCostSol: 0.002, grossReturnPct: 10, netReturnPct: 9.8, holdMs: 300,
  });
  store.insertSameSlotShadow({
    ...base, shadowId: 'rank-2', targetRank: 2, entryReferenceRank: 1,
    entryProfileId: 'R2-B5', cohortStage: 'HOLDOUT_B5_V1',
    triggerBuySol: 6, triggerBuyToDumpPct: 30,
    triggerWallet: 'trigger-wallet',
    status: 'NO_EXIT', rejectionReason: 'NO_TRADE_AT_OR_AFTER_EXIT_HORIZON',
    exitPhase: 'RESCUE_10000', exitReason: 'RESCUE_EXHAUSTED',
    rescueAttemptedHorizons: [5_000, 10_000],
  });
  store.flush();

  const summary = store.summary();
  assert.equal(summary.sameSlotShadow.scheduled, 2);
  assert.equal(summary.sameSlotShadow.entryFilled, 2);
  assert.equal(summary.sameSlotShadow.exitFilled, 1);
  assert.equal(summary.sameSlotShadow.noExit, 1);
  assert.equal(summary.sameSlotShadow.primaryProfileEpisodes, 1);
  assert.equal(summary.sameSlotShadow.primaryProfileMints, 1);
  assert.equal(summary.sameSlotShadow.primaryNoExitEpisodes, 1);
  assert.equal(summary.sameSlotShadow.rescueUnresolved, 1);
  assert.equal(summary.sameSlotShadow.winRatePct, 100);
  assert.equal(summary.sameSlotShadow.infrastructureExecutable, false);
  assert.deepEqual(
    summary.sameSlotShadowCohorts.map((row) => row.targetRank).sort(),
    [1, 2],
  );
  const stored = store.db.prepare(`
    SELECT infrastructure_executable,entry_profile_id,latency_model,competitor_gap_ms,
      trigger_buy_sol,data_quality_status,modeled_jito_tip_sol
    FROM same_slot_shadow_simulations WHERE shadow_id='rank-2'
  `).get();
  assert.deepEqual(stored, {
    infrastructure_executable: 0,
    entry_profile_id: 'R2-B5',
    latency_model: 'ENTRY_REFERENCE_TO_NEXT_COMPETITOR_V2',
    competitor_gap_ms: 20,
    trigger_buy_sol: 6,
    data_quality_status: 'TRUSTED',
    modeled_jito_tip_sol: 0.005,
  });
  const b5 = summary.sameSlotShadowCohorts.find((row) => row.entryProfileId === 'R2-B5');
  assert.equal(b5.cohortStage, 'HOLDOUT_B5_V1');
  assert.equal(b5.rescueUnresolved, 1);
  assert.equal(
    b5.combinedScenarios.find((row) => row.noExitLossPct === -15 && row.tipSol === 0.01)
      .averageNetReturnPct,
    -16,
  );
  assert.equal(
    b5.quickExitCombinedScenarios.find(
      (row) => row.noExitLossPct === -15 && row.tipSol === 0.01,
    ).averageNetReturnPct,
    -16,
  );
  const rank1 = summary.sameSlotShadowCohorts.find((row) => row.entryProfileId === 'R1-RAW');
  assert.equal(rank1.primaryExitFillRatePct, 100);
  assert.equal(rank1.primaryHoldP50Ms, 300);
  assert.equal(rank1.primaryHoldP95Ms, 300);
  store.close();
});

test('legacy price parses and drops over 40 percent stay out of strategy statistics', () => {
  const store = new ResearchStore({
    dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000,
    maxDumpDropPct: 40, acceptedDumpParseVersion: 'V3',
  });
  const insertDump = store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,drop_pct,parse_version,updated_at_ms
    ) VALUES(?,?,?,?,?,'[]','OBSERVING',0,?,?,?)
  `);
  insertDump.run('trusted', 'mint-1', 'pool-1', 1, 'STRICT', 20, 'V3', 1);
  insertDump.run('legacy', 'mint-2', 'pool-2', 2, 'STRICT', 20, 'V2', 2);
  insertDump.run('rug', 'mint-3', 'pool-3', 3, 'STRICT', 60, 'V3', 3);
  const insertObservation = store.db.prepare(`
    INSERT INTO same_slot_observations(
      observation_id,episode_id,mint,pool,observed_at_ms,slot,event_index,
      classification,receive_lag_ms,buy_sol,executable,rejection_reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
  `);
  for (const [index, episodeId] of ['trusted', 'legacy', 'rug'].entries()) {
    insertObservation.run(
      `observation-${episodeId}`, episodeId, `mint-${index + 1}`, `pool-${index + 1}`,
      index + 1, 1, 0, 'STRICT_AFTER_DUMP', 10, 1,
      'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE',
    );
  }

  const summary = store.summary();
  assert.equal(summary.dumps.independent, 1);
  assert.equal(summary.dumps.totalStoredEvents, 3);
  assert.equal(summary.dumps.excludedLegacyPriceEvents, 1);
  assert.equal(summary.dumps.excludedOverMaxDropEvents, 1);
  assert.equal(summary.sameSlotProbe.observations, 1);
  assert.equal(store.recentDumpsPage(1, 20).total, 1);
  assert.equal(store.recentSameSlotObservationsPage(1, 20).total, 1);
  store.close();
});

test('abnormal recovery events remain stored but are excluded from every strategy summary', () => {
  const store = new ResearchStore({
    dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000,
    acceptedDumpParseVersion: 'V3', maxReportedRecoveryPct: 500,
    sameSlotQuoteModel: 'SHADOW_V2',
  });
  store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,drop_pct,max_recovery_pct,
      parse_version,updated_at_ms
    ) VALUES('abnormal','mint','pool',1,'STRICT','[]','CONFIRMED',0,20,600,'V3',2)
  `).run();
  store.db.prepare(`
    INSERT INTO confirmations(
      confirmation_id,episode_id,profile_id,confirmed_at_ms,ordering_confidence,snapshot_json
    ) VALUES('abnormal:R1','abnormal','R1',2,'STRICT','{}')
  `).run();
  store.db.prepare(`
    INSERT INTO simulations(
      simulation_id,confirmation_id,episode_id,recovery_profile_id,entry_variant_id,
      entry_kind,entry_delay_ms,exit_profile_id,position_sol,quote_model,status,
      confirmed_at_ms,entry_at_ms,net_return_pct,created_at_ms,updated_at_ms
    ) VALUES('abnormal-sim','abnormal:R1','abnormal','R1','E100','DELAY',100,
      'H1',1,'EXEC_V4','CLOSED',2,3,100,2,4)
  `).run();
  store.db.prepare(`
    INSERT INTO same_slot_shadow_simulations(
      shadow_id,episode_id,target_rank,entry_profile_id,position_sol,exit_horizon_ms,
      quote_model,status,infrastructure_mode,infrastructure_executable,
      infrastructure_reason,data_quality_status,entry_assumption,entry_reference_rank,
      entry_at_ms,net_return_pct,created_at_ms,updated_at_ms
    ) VALUES('abnormal-shadow','abnormal',2,'R2-B2',1,500,'SHADOW_V2','CLOSED',
      'THEORETICAL_ONLY',0,'TEST','TRUSTED','THEORETICAL',1,2,100,2,4)
  `).run();

  const summary = store.summary();
  assert.equal(summary.dumps.independent, 0);
  assert.equal(summary.dumps.abnormalRecoveryEvents, 1);
  assert.equal(summary.dumps.recoveredEpisodes, 0);
  assert.equal(summary.execution.scheduled, 0);
  assert.equal(summary.sameSlotShadow.scheduled, 0);
  assert.deepEqual(summary.cohorts, []);
  assert.deepEqual(summary.sameSlotShadowCohorts, []);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM simulations').get().count, 1);
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

test('invalid V1/V2/V3 simulations can be removed without deleting V4 research data', () => {
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
  insert.run(
    'v4', 'confirmation', 'episode', 'R1', 'E100', 'DELAY', 100, 'H1', 1,
    'PUMPSWAP_CPMM_CAUSAL_CAPACITY_V4', 'NO_ENTRY', 1, 1, 1,
  );

  const removed = store.deleteSimulationsByQuoteModels([
    'PUMPSWAP_CPMM_EVENT_FEES_V1', 'PUMPSWAP_CPMM_EXECUTABLE_FEES_V2',
    'PUMPSWAP_CPMM_CAUSAL_CAPACITY_V3',
  ]);
  const remaining = store.db.prepare('SELECT simulation_id FROM simulations').all();

  assert.equal(removed, 3);
  assert.deepEqual(remaining, [{ simulation_id: 'v4' }]);
  store.close();
});
