'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config: productionConfig } = require('../src/config');
const { DumpBounceMatrix } = require('../src/core/DumpBounceMatrix');
const { DumpDetector } = require('../src/core/DumpDetector');
const { ExecutionSimulator } = require('../src/core/ExecutionSimulator');

function qualityConfig() {
  return {
    maxTradeSol: 1_000,
    maxQuoteReserveSol: 10_000,
    maxTradeToQuotePct: 50,
    maxEventReservePriceDeviationPct: 100,
    maxQuoteReserveChangeMultiple: 5,
  };
}

function executionConfig() {
  return {
    entryVariants: [], positionSizesSol: [], exitProfiles: [],
    entryTimeoutMs: 5_000, exitDelayMs: 0, exitTimeoutMs: 1_000, exitGraceMs: 1_000,
    quoteModel: 'BASE', buySlippageBps: 0, sellSlippageBps: 0,
    maxImmediateRoundTripLossPct: 100,
    maxEntryLiquidityUsagePct: 100, maxExitLiquidityUsagePct: 100,
    baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0,
  };
}

function trade({ at, tx, side, sol, quoteSol, sequence }) {
  const price = quoteSol / 1_000_000_000;
  return {
    type: 'ammTrade', market: 'PUMP_AMM', mint: 'mint', pool: 'pool',
    wallet: `wallet-${sequence}`, side, solAmount: sol, tokenAmount: sol / price,
    tokenDecimals: 6, poolBaseReservesRaw: String(1_000_000_000 * 1e6),
    poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
    effectiveQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
    virtualQuoteReservesRaw: '0', baseAmountRaw: String(Math.round(sol / price * 1e6)),
    quoteAmountRaw: String(Math.round(sol * 1e9)),
    userQuoteAmountRaw: String(Math.round(sol * 1e9)),
    price, reservePrice: price, receivedAtMs: at, timestampMs: at,
    slot: 10, transactionIndex: tx, instructionIndex: 1, eventIndex: 0,
    signature: `sig-${sequence}`, orderingConfidence: 'STRICT',
    lpFeeBasisPoints: 20, protocolFeeBasisPoints: 5, coinCreatorFeeBasisPoints: 0,
  };
}

function dump({ id, signalTrade, sellSol = 5, dropPct = 10 }) {
  return {
    episodeId: id, mint: 'mint', pool: 'pool', detectedAtMs: signalTrade.receivedAtMs,
    slot: signalTrade.slot, transactionIndex: signalTrade.transactionIndex,
    instructionIndex: signalTrade.instructionIndex, eventIndex: signalTrade.eventIndex,
    signature: signalTrade.signature, orderingConfidence: 'STRICT', signalTrade,
    sellSol, sellToQuotePct: sellSol / 70 * 100, dropPct,
    prePrice: 1e-7, postPrice: 9e-8, lowPrice: 9e-8, postQuoteSol: 70,
    poolAgeMs: 0,
  };
}

test('production direct-dump matrix has nine signal buckets and 108 strategies per dump', () => {
  assert.equal(productionConfig.dump.profiles[0].id, 'PUMPSWAP-ALL-DUMPS');
  assert.equal(productionConfig.dump.profiles[0].minPoolAgeMs, 0);
  assert.equal(productionConfig.dump.episodeCooldownMs, 0);
  assert.equal(productionConfig.dumpBounceMatrix.signalProfiles.length, 9);
  assert.equal(productionConfig.dumpBounceMatrix.entryVariants.length, 3);
  assert.equal(productionConfig.dumpBounceMatrix.exitProfiles.length, 36);
  assert.deepEqual(
    [...new Set(productionConfig.dumpBounceMatrix.exitProfiles
      .map((profile) => profile.fastTakeProfitPct))],
    [5, 8, 12],
  );
  assert.deepEqual(
    [...new Map(productionConfig.dumpBounceMatrix.exitProfiles.map((profile) => [
      profile.trailingActivationPct,
      profile.trailingDrawdownPct,
    ])).entries()],
    [[8, 3], [12, 4], [16, 5]],
  );
  assert.equal(productionConfig.dumpBounceMatrix.executionOverrides.priorityFeeSol, 0.0001);
  assert.equal(productionConfig.dumpBounceMatrix.executionOverrides.jitoTipSol, 0);

  const signal = trade({ at: 1_000, tx: 1, side: 'SELL', sol: 5, quoteSol: 70, sequence: 1 });
  const matrix = new DumpBounceMatrix({
    config: productionConfig.dumpBounceMatrix,
    executionConfig: productionConfig.execution,
    dataQualityConfig: productionConfig.sameSlotShadow,
  });
  const [confirmation] = matrix.confirm(dump({ id: 'qualified-dump', signalTrade: signal }));
  assert.equal(confirmation.profileId, 'DBM-S-D8');
  assert.deepEqual(confirmation.executionPlan.positionSizesSol, [1]);
  assert.equal(confirmation.executionPlan.requireStrictlyAfterEntryReference, true);
  assert.equal(confirmation.executionPlan.exitOnSecondDump, false);

  const simulator = new ExecutionSimulator({ config: productionConfig.execution });
  assert.equal(simulator.schedule(confirmation).length, 108);

  assert.deepEqual(matrix.confirm(dump({
    id: 'below-size', signalTrade: signal, sellSol: 4.99, dropPct: 10,
  })), []);
  assert.deepEqual(matrix.confirm(dump({
    id: 'below-impact', signalTrade: signal, sellSol: 5, dropPct: 7.99,
  })), []);
});

test('production intake records small impacts and drops above the old 40 percent ceiling', () => {
  const detect = ({ beforeQuote, afterQuote, sellSol, sequence }) => {
    const detector = new DumpDetector({ config: productionConfig.dump });
    detector.observeTrade(trade({
      at: 1_000, tx: 1, side: 'BUY', sol: 0.1, quoteSol: beforeQuote, sequence,
    }));
    return detector.observeTrade(trade({
      at: 1_010, tx: 2, side: 'SELL', sol: sellSol,
      quoteSol: afterQuote, sequence: sequence + 1,
    }));
  };
  assert.ok(detect({ beforeQuote: 100, afterQuote: 99.5, sellSol: 0.5, sequence: 20 }));
  assert.ok(detect({ beforeQuote: 100, afterQuote: 50, sellSol: 20, sequence: 30 }));
});

test('later dumps create independent add-on lots instead of invalidating an open lot', () => {
  const matrixConfig = {
    enabled: true,
    signalProfiles: [{
      id: 'DBM-TEST', minSellSol: 0, maxSellSol: Infinity,
      minDropPct: 0, maxDropPct: Infinity, positionSizesSol: [0.25],
    }],
    entryVariants: [{ id: 'E0', kind: 'DELAY', delayMs: 0 }],
    exitProfiles: [{
      id: 'MANAGED', kind: 'MANAGED', fastTakeProfitPct: 5,
      fastTakeProfitWindowMs: 5_000, trailingActivationPct: 4,
      trailingDrawdownPct: 2, maxHoldMs: 30_000, stopLossPct: null,
    }],
    entryTimeoutMs: 5_000, exitDelayMs: 0, exitTimeoutMs: 1_000, exitGraceMs: 1_000,
    quoteModel: 'DIRECT_TEST', executionOverrides: {},
  };
  const matrix = new DumpBounceMatrix({
    config: matrixConfig, executionConfig: executionConfig(),
    dataQualityConfig: qualityConfig(),
  });
  const rows = new Map();
  const simulator = new ExecutionSimulator({
    config: executionConfig(),
    store: {
      insertSimulation: (row) => rows.set(row.simulationId, { ...row }),
      updateSimulation: (row) => rows.set(row.simulationId, { ...row }),
    },
  });

  const firstSignal = trade({ at: 1_000, tx: 1, side: 'SELL', sol: 5, quoteSol: 70, sequence: 2 });
  const [firstConfirmation] = matrix.confirm(dump({
    id: 'dump-1', signalTrade: firstSignal,
  }));
  const [firstLot] = simulator.schedule(firstConfirmation);
  simulator.observeTrade(firstSignal);
  assert.equal(firstLot.status, 'PENDING_ENTRY', 'the dump transaction cannot fill its own E0 lot');
  simulator.observeTrade(trade({
    at: 1_010, tx: 2, side: 'BUY', sol: 1, quoteSol: 71, sequence: 3,
  }));
  assert.equal(firstLot.status, 'OPEN');

  const secondSignal = trade({ at: 1_100, tx: 3, side: 'SELL', sol: 5, quoteSol: 68, sequence: 4 });
  simulator.observeTrade(secondSignal, [{
    episodeId: 'dump-1', secondDump: true, status: 'SECOND_DUMP',
  }]);
  assert.equal(firstLot.status, 'OPEN', 'an add-on dump must not close the earlier lot');
  const [secondConfirmation] = matrix.confirm(dump({
    id: 'dump-2', signalTrade: secondSignal,
  }));
  const [secondLot] = simulator.schedule(secondConfirmation);
  simulator.observeTrade(trade({
    at: 1_110, tx: 4, side: 'BUY', sol: 1, quoteSol: 69, sequence: 5,
  }));
  assert.equal(firstLot.status, 'OPEN');
  assert.equal(secondLot.status, 'OPEN');
  assert.notEqual(firstLot.simulationId, secondLot.simulationId);
});

test('managed exits support fast profit, trailing profit, optional stop and max hold', () => {
  const simulator = new ExecutionSimulator({ config: executionConfig() });
  const base = {
    entryAtMs: 1_000,
    executionPlan: { ...executionConfig(), exitOnSecondDump: false },
    exitProfile: {
      kind: 'MANAGED', fastTakeProfitPct: 5, fastTakeProfitWindowMs: 5_000,
      trailingActivationPct: 4, trailingDrawdownPct: 2,
      maxHoldMs: 30_000, stopLossPct: -12,
    },
    maxExitAtMs: 31_000,
  };
  assert.equal(simulator._exitReason({ ...base, mfeNetPct: 6 }, null, 5.1, 2_000),
    'FAST_TAKE_PROFIT_5');
  assert.equal(simulator._exitReason({ ...base, mfeNetPct: 8 }, null, 5.9, 8_000),
    'TRAILING_TAKE_PROFIT_2');
  assert.equal(simulator._exitReason({ ...base, mfeNetPct: 0 }, null, -12.1, 8_000),
    'EXECUTABLE_STOP_LOSS');
  assert.equal(simulator._exitReason({ ...base, mfeNetPct: 1 }, null, 0, 31_000),
    'MAX_HOLD');
});
