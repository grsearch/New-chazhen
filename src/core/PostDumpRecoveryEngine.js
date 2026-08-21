'use strict';

const { DumpDetector } = require('./DumpDetector');
const { ToxicFlowFilter } = require('./ToxicFlowFilter');
const { RecoveryConfirmer } = require('./RecoveryConfirmer');
const { ExecutionSimulator } = require('./ExecutionSimulator');

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
    this.execution = new ExecutionSimulator({ config: config.execution, store, now });
    this.metrics = {
      events: 0,
      trades: 0,
      migrations: 0,
      dumps: 0,
      confirmations: 0,
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
    this.store.recordTrade(event);

    const dump = this.dumpDetector.observeTrade(event);
    const recoveryResult = this.recovery.observeTrade(event);
    for (const snapshot of recoveryResult.updates) this.store.updateDump(snapshot);
    for (const outcome of recoveryResult.toxicOutcomes) {
      this.toxicFilter.recordToxicOutcome(
        outcome.wallet, outcome.reason, outcome.timestampMs, outcome.episodeId,
      );
    }
    for (const confirmation of recoveryResult.confirmations) {
      this.store.insertConfirmation(confirmation);
      this.execution.schedule(confirmation);
      this.metrics.confirmations += 1;
    }

    if (dump) {
      const toxic = this.toxicFilter.evaluateDump(dump);
      this.store.insertDump(dump, toxic);
      const initial = this.recovery.startEpisode(dump, toxic);
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
      execution: this.execution.health(),
    };
  }
}

module.exports = { PostDumpRecoveryEngine };
