'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostDumpRecoveryEngine } = require('../src/core/PostDumpRecoveryEngine');

class MemoryStore {
  constructor() {
    this.trades = [];
    this.dumps = [];
    this.confirmations = [];
    this.sameSlotObservations = [];
    this.simulations = new Map();
  }
  listToxicWallets() { return []; }
  recordTrade(row) { this.trades.push(row); }
  insertDump(dump, toxic) { this.dumps.push({ dump, toxic }); }
  updateDump() {}
  insertSameSlotObservation(row) { this.sameSlotObservations.push(row); }
  insertConfirmation(row) { this.confirmations.push(row); }
  insertSimulation(row) { this.simulations.set(row.simulationId, { ...row }); }
  updateSimulation(row) { this.simulations.set(row.simulationId, { ...row }); }
  upsertToxicWallet() {}
  flush() {}
}

function configuration() {
  return {
    dump: {
      preWindowMs: 5_000, priceFreshMs: 5_000, episodeCooldownMs: 0,
      stateRetentionMs: 60_000,
      profiles: [{ id: 'TEST-DUMP', minSellToQuotePct: 5, minDropPct: 15, minPostQuoteSol: 20, minPoolAgeMs: 0 }],
    },
    toxic: {
      toxicWallets: new Set(), relatedWallets: new Set(), minPreTrades: 8,
      mechanicalMinBuySharePct: 90, mechanicalMinRunupPct: 40,
      maxLargestBuyerSharePct: 60,
      hardRejectReasons: new Set(['CREATOR_SELL','MECHANICAL_RUNUP','BUYER_CONCENTRATION']),
    },
    recovery: {
      maxObservationMs: 20_000, maxSlotDelta: 40, minValidBuySol: 0.05,
      secondDumpMinSol: 1, secondDumpFractionOfInitial: 0.2,
      secondDumpMinPriceDropPct: 8, buyerStallMs: 5_000,
      profiles: [{
        id: 'PD-R1', maxSlotDelta: 4, minPriceBouncePct: 5,
        minDropRecoveryPct: 20, minUniqueBuyers: 2, minBuySol: 0.5,
        minBuyToDumpPct: 15, requirePositiveNetFlow: false,
      }],
    },
    execution: {
      positionSizesSol: [1],
      entryVariants: [{ id: 'E100', kind: 'DELAY', delayMs: 100 }],
      entryTimeoutMs: 2_000, exitDelayMs: 200, exitTimeoutMs: 2_000, exitGraceMs: 2_000,
      quoteModel: 'TEST', buySlippageBps: 0, sellSlippageBps: 0,
      maxImmediateRoundTripLossPct: 100,
      maxEntryLiquidityUsagePct: 100,
      maxExitLiquidityUsagePct: 100,
      baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0,
      exitProfiles: [{ id: 'H1', kind: 'FIXED', holdMs: 1_000 }],
    },
  };
}

function trade({ at, slot, tx, side, sol, price, wallet, quoteSol, sequence }) {
  const baseTokens = 1_000_000_000;
  return {
    type: 'ammTrade', market: 'PUMP_AMM', mint: 'mint', pool: 'pool',
    coinCreator: 'creator', wallet, side, solAmount: sol,
    tokenAmount: sol / price, tokenDecimals: 6,
    poolBaseReservesRaw: String(Math.round(baseTokens * 1e6)),
    poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
    virtualQuoteReservesRaw: '0', effectiveQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
    baseAmountRaw: String(Math.round((sol / price) * 1e6)),
    quoteAmountRaw: String(Math.round(sol * 1e9)), userQuoteAmountRaw: String(Math.round(sol * 1e9)),
    reservePrice: price, price, receivedAtMs: at, timestampMs: at, chainTimestampMs: at - 10,
    slot, transactionIndex: tx, instructionIndex: 1, eventIndex: 0,
    signature: `sig-${sequence}`, receiveSequence: sequence, orderingConfidence: 'STRICT',
    lpFeeBasisPoints: 20, protocolFeeBasisPoints: 5, coinCreatorFeeBasisPoints: 0,
  };
}

test('strategy waits for next-slot multi-wallet recovery and delayed executable quotes', () => {
  const base = 1_800_000_000_000;
  let now = base;
  const store = new MemoryStore();
  const engine = new PostDumpRecoveryEngine({ config: configuration(), store, now: () => now });
  const observe = (row) => { now = row.receivedAtMs; return engine.observe(row); };

  observe(trade({ at: base - 100, slot: 500, tx: 1, side: 'BUY', sol: 0.1, price: 1e-7, wallet: 'prior', quoteSol: 100, sequence: 1 }));
  assert.equal(store.trades.length, 0, 'unrelated global trades must stay in memory only');
  const signal = observe(trade({ at: base, slot: 501, tx: 1, side: 'SELL', sol: 20, price: 7e-8, wallet: 'seller', quoteSol: 70, sequence: 2 }));
  assert.ok(signal.dump, 'relative reserve pressure and drop should create one dump episode');
  assert.deepEqual(
    store.trades.map((row) => row.signature),
    ['sig-1', 'sig-2'],
    'dump detection backfills only the causal pre-window and signal trade',
  );
  assert.equal(store.confirmations.length, 0, 'dump detection cannot enter immediately');

  observe(trade({ at: base + 100, slot: 501, tx: 2, side: 'BUY', sol: 10, price: 7.5e-8, wallet: 'same-slot', quoteSol: 75, sequence: 3 }));
  assert.equal(store.confirmations.length, 0, 'same-slot capital is statistics-only');
  assert.equal(store.simulations.size, 0, 'same-slot observations cannot create shadow positions');
  assert.equal(store.sameSlotObservations.length, 1);
  assert.equal(store.sameSlotObservations[0].classification, 'STRICT_AFTER_DUMP');
  assert.equal(store.sameSlotObservations[0].executable, false);
  assert.equal(store.sameSlotObservations[0].receiveLagMs, 100);

  observe(trade({ at: base + 200, slot: 502, tx: 1, side: 'BUY', sol: 1.6, price: 7.3e-8, wallet: 'buyer-a', quoteSol: 73, sequence: 4 }));
  assert.equal(store.sameSlotObservations.length, 1, 'next-slot buys are not probe observations');
  observe(trade({ at: base + 250, slot: 502, tx: 2, side: 'BUY', sol: 1.6, price: 7.7e-8, wallet: 'buyer-b', quoteSol: 77, sequence: 5 }));
  assert.equal(store.confirmations.length, 1, 'two independent buyers and real recovery should confirm R1');
  assert.ok([...store.simulations.values()].every((row) => row.positionSol === 1));
  assert.ok([...store.simulations.values()].every((row) => row.status === 'PENDING_ENTRY'));

  observe(trade({ at: base + 300, slot: 502, tx: 3, side: 'BUY', sol: 0.1, price: 7.8e-8, wallet: 'noise', quoteSol: 78, sequence: 6 }));
  assert.ok([...store.simulations.values()].every((row) => row.status === 'PENDING_ENTRY'), '100ms delay is measured from confirmation');
  observe(trade({ at: base + 400, slot: 503, tx: 1, side: 'BUY', sol: 0.2, price: 8e-8, wallet: 'fill', quoteSol: 80, sequence: 7 }));
  assert.ok([...store.simulations.values()].every((row) => row.status === 'OPEN'));

  observe(trade({ at: base + 1_450, slot: 506, tx: 1, side: 'BUY', sol: 0.2, price: 8.4e-8, wallet: 'exit-trigger', quoteSol: 84, sequence: 8 }));
  assert.ok([...store.simulations.values()].every((row) => row.status === 'PENDING_EXIT'), 'fixed hold only triggers an exit request');
  observe(trade({ at: base + 1_700, slot: 507, tx: 1, side: 'BUY', sol: 0.2, price: 8.5e-8, wallet: 'exit-fill', quoteSol: 85, sequence: 9 }));
  const resolved = [...store.simulations.values()];
  assert.ok(resolved.every((row) => row.status === 'CLOSED'));
  assert.ok(resolved.every((row) => row.exitHorizonLagMs >= 300));
  assert.ok(resolved.every((row) => Number.isFinite(row.netReturnPct)));
  assert.equal(store.trades.length, 9, 'post-dump recovery and execution quotes remain auditable');
});

test('execution simulator independently blocks a same-slot confirmation', () => {
  const store = new MemoryStore();
  const engine = new PostDumpRecoveryEngine({ config: configuration(), store });
  const created = engine.execution.schedule({
    confirmationId: 'invalid:same-slot',
    episodeId: 'invalid',
    profileId: 'PD-R1',
    confirmedAtMs: Date.now(),
    slot: 10,
    snapshot: { slotDelta: 0 },
    dump: { pool: 'pool', mint: 'mint' },
  });
  assert.deepEqual(created, []);
  assert.equal(engine.execution.health().blockedSameSlot, 1);
  assert.equal(store.simulations.size, 0);
});

test('a second dump before delayed entry invalidates every pending shadow position', () => {
  const base = 1_800_050_000_000;
  let now = base;
  const store = new MemoryStore();
  const engine = new PostDumpRecoveryEngine({ config: configuration(), store, now: () => now });
  const observe = (row) => { now = row.receivedAtMs; return engine.observe(row); };
  observe(trade({ at: base - 100, slot: 1, tx: 1, side: 'BUY', sol: 0.1, price: 1e-7, wallet: 'prior', quoteSol: 100, sequence: 31 }));
  observe(trade({ at: base, slot: 2, tx: 1, side: 'SELL', sol: 20, price: 7e-8, wallet: 'seller', quoteSol: 70, sequence: 32 }));
  observe(trade({ at: base + 100, slot: 3, tx: 1, side: 'BUY', sol: 1.6, price: 7.3e-8, wallet: 'buyer-a', quoteSol: 73, sequence: 33 }));
  observe(trade({ at: base + 150, slot: 3, tx: 2, side: 'BUY', sol: 1.6, price: 7.7e-8, wallet: 'buyer-b', quoteSol: 77, sequence: 34 }));
  assert.ok([...store.simulations.values()].every((row) => row.status === 'PENDING_ENTRY'));

  observe(trade({ at: base + 200, slot: 4, tx: 1, side: 'SELL', sol: 5, price: 6.5e-8, wallet: 'seller-2', quoteSol: 65, sequence: 35 }));
  const rejected = [...store.simulations.values()];
  assert.ok(rejected.every((row) => row.status === 'NO_ENTRY'));
  assert.ok(rejected.every((row) => row.rejectionReason === 'RECOVERY_INVALIDATED_BEFORE_ENTRY'));
  assert.equal(engine.execution.health().invalidatedBeforeEntry, rejected.length);
  assert.equal(engine.execution.health().entryFilled, 0);
});

test('entry is rejected when the requested position consumes too much pool liquidity', () => {
  const base = 1_800_060_000_000;
  const store = new MemoryStore();
  const config = configuration();
  config.execution.maxEntryLiquidityUsagePct = 0.5;
  const engine = new PostDumpRecoveryEngine({ config, store, now: () => base });
  engine.execution.schedule({
    confirmationId: 'capacity:R1', episodeId: 'capacity', profileId: 'PD-R1',
    confirmedAtMs: base, slot: 10, snapshot: { slotDelta: 1 },
    dump: { pool: 'pool', mint: 'mint', lowPrice: 7e-8, prePrice: 1e-7 },
  });
  engine.execution.observeTrade(
    trade({ at: base + 100, slot: 11, tx: 1, side: 'BUY', sol: 0.1, price: 8e-8, wallet: 'quote', quoteSol: 80, sequence: 41 }),
  );
  const rejected = [...store.simulations.values()];
  assert.ok(rejected.every((row) => row.status === 'NO_ENTRY'));
  assert.ok(rejected.every((row) => row.rejectionReason === 'INSUFFICIENT_ROUND_TRIP_LIQUIDITY'));
  assert.ok(rejected.every((row) => Number.isFinite(row.entryCapacityRoundTripLossPct)));
});

test('entry is rejected when immediate net round-trip cost exceeds the configured limit', () => {
  const base = 1_800_070_000_000;
  const store = new MemoryStore();
  const config = configuration();
  config.execution.maxImmediateRoundTripLossPct = 0;
  const engine = new PostDumpRecoveryEngine({ config, store, now: () => base });
  engine.execution.schedule({
    confirmationId: 'cost:R1', episodeId: 'cost', profileId: 'PD-R1',
    confirmedAtMs: base, slot: 10, snapshot: { slotDelta: 1 },
    dump: { pool: 'pool', mint: 'mint', lowPrice: 7e-8, prePrice: 1e-7 },
  });
  engine.execution.observeTrade(
    trade({ at: base + 100, slot: 11, tx: 1, side: 'BUY', sol: 0.1, price: 8e-8, wallet: 'quote', quoteSol: 100, sequence: 42 }),
  );
  const rejected = [...store.simulations.values()];
  assert.ok(rejected.every((row) => row.status === 'NO_ENTRY'));
  assert.ok(rejected.every((row) => row.rejectionReason === 'ROUND_TRIP_COST_TOO_HIGH'));
  assert.ok(rejected.every((row) => row.entryCapacityRoundTripLossPct > 0));
});

test('same-slot probe expires inactive dumps without creating strategy state', () => {
  const store = new MemoryStore();
  const engine = new PostDumpRecoveryEngine({ config: configuration(), store });
  engine.sameSlotProbe.startEpisode({
    episodeId: 'probe-only', pool: 'pool', mint: 'mint', slot: 10,
    detectedAtMs: 1_000, postPrice: 1, signalTrade: {},
  });
  assert.equal(engine.sameSlotProbe.health().activeDumps, 1);
  engine.sameSlotProbe.advanceTime(6_001);
  assert.equal(engine.sameSlotProbe.health().activeDumps, 0);
  assert.equal(store.confirmations.length, 0);
  assert.equal(store.simulations.size, 0);
});

test('creator dumps are recorded but never reach confirmation', () => {
  const base = 1_800_100_000_000;
  let now = base;
  const store = new MemoryStore();
  const engine = new PostDumpRecoveryEngine({ config: configuration(), store, now: () => now });
  const observe = (row) => { now = row.receivedAtMs; return engine.observe(row); };
  observe(trade({ at: base - 100, slot: 1, tx: 1, side: 'BUY', sol: 0.1, price: 1e-7, wallet: 'prior', quoteSol: 100, sequence: 11 }));
  observe(trade({ at: base, slot: 2, tx: 1, side: 'SELL', sol: 20, price: 7e-8, wallet: 'creator', quoteSol: 70, sequence: 12 }));
  assert.equal(store.dumps[0].toxic.rejected, true);
  observe(trade({ at: base + 100, slot: 3, tx: 1, side: 'BUY', sol: 5, price: 8e-8, wallet: 'a', quoteSol: 80, sequence: 13 }));
  observe(trade({ at: base + 150, slot: 3, tx: 2, side: 'BUY', sol: 5, price: 9e-8, wallet: 'b', quoteSol: 90, sequence: 14 }));
  assert.equal(store.confirmations.length, 0);
});
