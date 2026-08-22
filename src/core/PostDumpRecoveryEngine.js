'use strict';

const { DumpDetector } = require('./DumpDetector');
const { ToxicFlowFilter } = require('./ToxicFlowFilter');
const { RecoveryConfirmer } = require('./RecoveryConfirmer');
const { ExecutionSimulator } = require('./ExecutionSimulator');
const { SameSlotProbe } = require('./SameSlotProbe');

class PostDumpRecoveryEngine {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.dumpDetector = new DumpDetector({ config: config.dump, now });
    this.toxicFilter = new ToxicFlowFilter({ config: config.toxic, store });
    this.recovery = new RecoveryConfirmer({
      config: config.recovery,
      toxicFilter: this.toxicFilter,
      now,
    });
    this.sameSlotProbe = new SameSlotProbe();
    this.execution = new ExecutionSimulator({ config: config.execution, store, now });
    this.metrics = {
      events: 0,
      trades: 0,
      migrations: 0,
      dumps: 0,
      confirmations: 0,
      blockedSameSlotConfirmations: 0,
      sameSlotObservations: 0,
      researchTradeWrites: 0,
      errors: 0,
      lastEventAtMs: null,
    };
  }

  observe(event) {
    this.metrics.events += 1;
    this.metrics.lastEventAtMs = this.now();
    if (event?.type === 'migration') {
      this.dumpDetector.observeMigration(event);
      this.metrics.migrations += 1;
      return { dump: null, confirmations: [] };
    }
    if (event?.type !== 'ammTrade') return { dump: null, confirmations: [] };
    this.metrics.trades += 1;

    // Persist only causal research windows. DumpDetector still keeps the short
    // pre-window in memory, so unrelated PumpSwap traffic never reaches SQLite.
    const activeResearchWindow = this.recovery.isObservingPool(event.pool)
      || this.execution.isTrackingPool(event.pool);
    if (activeResearchWindow) {
      this.store.recordTrade(event);
      this.metrics.researchTradeWrites += 1;
    }

    const dump = this.dumpDetector.observeTrade(event);
    const recoveryResult = this.recovery.observeTrade(event);
    const sameSlotObservations = this.sameSlotProbe.observeTrade(event);
    for (const observation of sameSlotObservations) {
      this.store.insertSameSlotObservation?.(observation);
      this.metrics.sameSlotObservations += 1;
    }
    for (const snapshot of recoveryResult.updates) this.store.updateDump(snapshot);
    for (const outcome of recoveryResult.toxicOutcomes) {
      this.toxicFilter.recordToxicOutcome(
        outcome.wallet, outcome.reason, outcome.timestampMs, outcome.episodeId,
      );
    }
    for (const confirmation of recoveryResult.confirmations) {
      if (!(Number(confirmation.snapshot?.slotDelta) > 0)) {
        this.metrics.blockedSameSlotConfirmations += 1;
        continue;
      }
      this.store.insertConfirmation(confirmation);
      this.execution.schedule(confirmation);
      this.metrics.confirmations += 1;
    }

    if (dump) {
      const preWindowStartMs = dump.detectedAtMs - this.config.dump.preWindowMs;
      const researchTrades = this.dumpDetector.recentTrades(dump.pool, preWindowStartMs);
      for (const researchTrade of researchTrades) this.store.recordTrade(researchTrade);
      this.metrics.researchTradeWrites += researchTrades.length;
      const toxic = this.toxicFilter.evaluateDump(dump);
      this.store.insertDump(dump, toxic);
      const initial = this.recovery.startEpisode(dump, toxic);
      this.sameSlotProbe.startEpisode(dump);
      this.store.updateDump(initial);
      this.metrics.dumps += 1;
      dump.toxic = toxic;
    }

    this.execution.observeTrade(event, recoveryResult.updates);
    return { dump, confirmations: recoveryResult.confirmations };
  }

  advanceTime(now = this.now()) {
    const expired = this.recovery.advanceTime(now);
    for (const snapshot of expired) this.store.updateDump(snapshot);
    this.sameSlotProbe.advanceTime(now);
    this.execution.advanceTime(now);
    this.store.flush();
  }

  health() {
    return {
      mode: 'RESEARCH_ONLY_POST_DUMP_RECOVERY',
      sendsTransactions: false,
      ...this.metrics,
      dumpDetector: this.dumpDetector.health(),
      toxicFilter: this.toxicFilter.health(),
      recovery: this.recovery.health(),
      sameSlotProbe: this.sameSlotProbe.health(),
      execution: this.execution.health(),
    };
  }
}

module.exports = { PostDumpRecoveryEngine };
