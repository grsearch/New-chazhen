'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');

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
  });
  store.insertSimulation({
    ...baseSimulation, simulationId: 'no-exit', status: 'NO_EXIT', entryAtMs: now + 400,
    rejectionReason: 'NO_CAUSAL_EXIT_QUOTE',
  });
  store.flush();
  const summary = store.summary();
  assert.equal(summary.dumps.independent, 1);
  assert.equal(summary.dumps.nextSlotRecoveryRatePct, 100);
  assert.equal(summary.sameSlotProbe.observations, 1);
  assert.equal(summary.sameSlotProbe.strictAfterDumpBuys, 1);
  assert.equal(summary.sameSlotProbe.executableSignals, 0, 'store must force probe rows to non-executable');
  assert.equal(summary.execution.scheduled, 2);
  assert.equal(summary.execution.exitFilled, 1);
  assert.equal(summary.execution.noExit, 1);
  assert.equal(summary.execution.resolved, 1, 'NO_EXIT must not be converted into an invented return');
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
