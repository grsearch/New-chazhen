'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CausalBackrunConfirmer } = require('../src/core/CausalBackrunConfirmer');
const { ExecutionSimulator } = require('../src/core/ExecutionSimulator');

function trade({ at, slot, tx, side = 'BUY', sol, quoteSol, sequence }) {
  const price = quoteSol / 1_000_000_000;
  return {
    type: 'ammTrade', market: 'PUMP_AMM', mint: 'mint', pool: 'pool', wallet: `w${sequence}`,
    side, solAmount: sol, tokenAmount: sol / price, tokenDecimals: 6,
    poolBaseReservesRaw: String(1_000_000_000 * 1e6),
    poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
    effectiveQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
    virtualQuoteReservesRaw: '0', baseAmountRaw: String(Math.round(sol / price * 1e6)),
    quoteAmountRaw: String(Math.round(sol * 1e9)),
    userQuoteAmountRaw: String(Math.round(sol * 1e9)),
    price, reservePrice: price, receivedAtMs: at, timestampMs: at, slot,
    transactionIndex: tx, instructionIndex: 1, eventIndex: 0,
    signature: `sig-${sequence}`, orderingConfidence: 'STRICT',
    lpFeeBasisPoints: 20, protocolFeeBasisPoints: 5, coinCreatorFeeBasisPoints: 0,
  };
}

function qualityConfig() {
  return {
    maxTradeSol: 1_000, maxQuoteReserveSol: 10_000, maxTradeToQuotePct: 50,
    maxEventReservePriceDeviationPct: 100, maxQuoteReserveChangeMultiple: 5,
  };
}

function executionConfig() {
  return {
    entryVariants: [{ id: 'OLD', kind: 'DELAY', delayMs: 0 }],
    positionSizesSol: [1], exitProfiles: [{ id: 'OLD', kind: 'FIXED', holdMs: 1_000 }],
    entryTimeoutMs: 2_000, exitDelayMs: 200, exitTimeoutMs: 2_000, exitGraceMs: 2_000,
    quoteModel: 'OLD', buySlippageBps: 0, sellSlippageBps: 0,
    maxImmediateRoundTripLossPct: 100, maxEntryLiquidityUsagePct: 100,
    maxExitLiquidityUsagePct: 100, baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0,
  };
}

function cohortConfig() {
  return {
    enabled: true,
    profiles: [
      { id: 'R2-ABS10-V1', minFirstBuySol: 10, minDropPct: 5, maxDropPct: 40 },
      { id: 'R2-ABS5-D15-30-V1', minFirstBuySol: 5, minDropPct: 15, maxDropPct: 30 },
    ],
    entryVariants: [
      { id: 'E50', kind: 'DELAY', delayMs: 50 },
      { id: 'NEXT_SLOT', kind: 'NEXT_SLOT', delayMs: 0 },
    ],
    positionSizesSol: [1],
    exitProfiles: [{ id: 'H010', kind: 'FIXED', holdMs: 100 }],
    combinationGrid: [{
      positionSol: 1, entryVariantIds: ['E50', 'NEXT_SLOT'], exitProfileIds: ['H010'],
    }],
    entryTimeoutMs: 2_000, exitTimeoutMs: 2_000, exitGraceMs: 2_000,
    triggerRetentionMs: 2_000, quoteModel: 'PUMPSWAP_CAUSAL_BACKRUN_FROZEN_V1',
  };
}

function dump(signalTrade, dropPct = 20) {
  return {
    episodeId: 'episode', mint: 'mint', pool: 'pool', slot: signalTrade.slot,
    detectedAtMs: signalTrade.receivedAtMs, signalTrade, dropPct, sellSol: 20,
    prePrice: 1e-7, postPrice: 7e-8, lowPrice: 7e-8, postQuoteSol: 70,
  };
}

test('frozen cohorts never replace a dust first buy with a later large buy', () => {
  const signal = trade({ at: 1_000, slot: 10, tx: 1, side: 'SELL', sol: 20,
    quoteSol: 70, sequence: 1 });
  const confirmer = new CausalBackrunConfirmer({
    config: cohortConfig(), executionConfig: executionConfig(),
    dataQualityConfig: qualityConfig(),
  });
  confirmer.startEpisode(dump(signal), { rejected: false });
  assert.deepEqual(confirmer.observeTrade(trade({
    at: 1_010, slot: 10, tx: 2, sol: 0.1, quoteSol: 70.1, sequence: 2,
  })), []);
  assert.deepEqual(confirmer.observeTrade(trade({
    at: 1_020, slot: 10, tx: 3, sol: 20, quoteSol: 90, sequence: 3,
  })), []);
  assert.equal(confirmer.health().firstStrictBuys, 1);
  assert.equal(confirmer.health().belowThreshold, 1);
});

test('qualified first buy creates both frozen profiles without a quote-reserve gate', () => {
  const measured = [];
  const signal = trade({ at: 2_000, slot: 20, tx: 1, side: 'SELL', sol: 20,
    quoteSol: 70, sequence: 4 });
  const confirmer = new CausalBackrunConfirmer({
    config: cohortConfig(), executionConfig: executionConfig(),
    dataQualityConfig: qualityConfig(),
    executionProbe: {
      measure: (row) => measured.push(row), finalize: () => null,
    },
  });
  confirmer.startEpisode(dump(signal), { rejected: false });
  const confirmations = confirmer.observeTrade(trade({
    at: 2_010, slot: 20, tx: 2, sol: 12, quoteSol: 82, sequence: 5,
  }));
  assert.deepEqual(confirmations.map((row) => row.profileId).sort(), [
    'R2-ABS10-V1', 'R2-ABS5-D15-30-V1',
  ]);
  assert.ok(confirmations.every((row) => row.allowSameSlotTrigger));
  assert.ok(confirmations.every((row) => row.snapshot.postQuoteGate === null));
  assert.equal(measured.length, 2);
});

test('causal entry waits beyond the trigger trade and closes on first horizon quote', () => {
  let now = 3_000;
  const rows = new Map();
  const store = {
    insertSimulation: (row) => rows.set(row.simulationId, { ...row }),
    updateSimulation: (row) => rows.set(row.simulationId, { ...row }),
  };
  const signal = trade({ at: 3_000, slot: 30, tx: 1, side: 'SELL', sol: 20,
    quoteSol: 70, sequence: 6 });
  const trigger = trade({ at: 3_010, slot: 30, tx: 2, sol: 12, quoteSol: 82, sequence: 7 });
  const confirmer = new CausalBackrunConfirmer({
    config: cohortConfig(), executionConfig: executionConfig(),
    dataQualityConfig: qualityConfig(), now: () => now,
  });
  confirmer.startEpisode(dump(signal), { rejected: false });
  const confirmation = confirmer.observeTrade(trigger)[0];
  const simulator = new ExecutionSimulator({ config: executionConfig(), store, now: () => now });
  const scheduled = simulator.schedule(confirmation);
  assert.equal(scheduled.length, 2);
  simulator.observeTrade(trigger);
  assert.ok(scheduled.every((row) => row.status === 'PENDING_ENTRY'),
    'the trigger post-state must never be reused as the entry fill');

  now = 3_059;
  simulator.observeTrade(trade({ at: now, slot: 30, tx: 3, sol: 1, quoteSol: 83, sequence: 8 }));
  assert.ok(scheduled.every((row) => row.status === 'PENDING_ENTRY'));
  now = 3_060;
  simulator.observeTrade(trade({ at: now, slot: 30, tx: 4, sol: 1, quoteSol: 84, sequence: 9 }));
  const delay = scheduled.find((row) => row.entryVariantId === 'E50');
  const nextSlot = scheduled.find((row) => row.entryVariantId === 'NEXT_SLOT');
  assert.equal(delay.status, 'OPEN');
  assert.equal(delay.entrySignature, 'sig-9');
  assert.equal(nextSlot.status, 'PENDING_ENTRY');

  now = 3_100;
  simulator.observeTrade(trade({ at: now, slot: 31, tx: 1, sol: 1, quoteSol: 85, sequence: 10 }));
  assert.equal(nextSlot.status, 'OPEN');
  assert.equal(nextSlot.entrySignature, 'sig-10');

  now = 3_160;
  simulator.observeTrade(trade({ at: now, slot: 31, tx: 2, sol: 1, quoteSol: 86, sequence: 11 }));
  assert.equal(delay.status, 'CLOSED');
  assert.equal(delay.exitSignature, 'sig-11');
  assert.equal(delay.holdMs, 100);
  assert.equal(nextSlot.status, 'OPEN');
});
