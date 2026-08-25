'use strict';

const {
  quoteImmediateRoundTrip, quoteSell, transactionFeeSol,
} = require('./AmmQuote');
const { strictlyAfter } = require('./SlotAssembler');
const { assessTradeDataQuality } = require('./TradeDataQuality');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function sameAsset(dump, trade) {
  if (!dump || !trade || dump.pool !== trade.pool || dump.mint !== trade.mint) return false;
  const signalDecimals = finite(dump.signalTrade?.tokenDecimals);
  const tradeDecimals = finite(trade.tokenDecimals);
  return signalDecimals == null || tradeDecimals == null || signalDecimals === tradeDecimals;
}

function causallyAfter(candidate, reference) {
  const candidateSlot = finite(candidate?.slot);
  const referenceSlot = finite(reference?.slot);
  if (candidateSlot == null || referenceSlot == null) return false;
  if (candidateSlot !== referenceSlot) return candidateSlot > referenceSlot;
  return strictlyAfter(candidate, reference) === true;
}

function pct(part, whole) {
  return whole > 0 ? part / whole * 100 : null;
}

class SameSlotShadowSimulator {
  constructor({ config, store = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.txFeeSol = transactionFeeSol(config);
    this.responseBudgetMs = [
      config.parseBudgetMs, config.buildBudgetMs, config.signBudgetMs, config.sendBudgetMs,
    ].reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
    this.rescueHorizonsMs = [...new Set((config.rescueHorizonsMs || [])
      .map((value) => Math.trunc(finite(value, 0)))
      .filter((value) => value > 0))].sort((left, right) => left - right);
    this.episodes = new Map();
    this.episodesByPool = new Map();
    this.simulations = new Map();
    this.simulationsByPool = new Map();
    this.metrics = {
      eligibleEpisodes: 0,
      toxicEpisodesSkipped: 0,
      scheduled: 0,
      entryFilled: 0,
      noEntry: 0,
      exitFilled: 0,
      noExit: 0,
      rank1Entries: 0,
      rank2Entries: 0,
      insufficientRoundTripLiquidity: 0,
      roundTripCostTooHigh: 0,
      rank2B2Entries: 0,
      rank2B5Entries: 0,
      rescueStarted: 0,
      rescue5sFilled: 0,
      rescue10sFilled: 0,
      rescueUnresolved: 0,
      dataQualityQuarantined: 0,
    };
  }

  startEpisode(dump, toxic = {}) {
    if (!this.config.enabled || !dump?.episodeId || !dump.pool || !dump.signalTrade) return [];
    if (toxic.rejected) {
      this.metrics.toxicEpisodesSkipped += 1;
      return [];
    }
    this.episodes.set(dump.episodeId, {
      dump,
      trades: [],
      finalized: false,
      dataQuality: assessTradeDataQuality(dump.signalTrade, this.config),
    });
    const episodeIds = this.episodesByPool.get(dump.pool) || new Set();
    episodeIds.add(dump.episodeId);
    this.episodesByPool.set(dump.pool, episodeIds);
    this.metrics.eligibleEpisodes += 1;
    return [];
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.pool) return [];
    const changed = [];
    const finalizedNow = new Set();
    const episodeIds = this.episodesByPool.get(trade.pool);
    for (const episodeId of [...(episodeIds || [])]) {
      const state = this.episodes.get(episodeId);
      const dump = state?.dump;
      if (!state || state.finalized || !sameAsset(dump, trade)) continue;
      const tradeSlot = finite(trade.slot);
      const dumpSlot = finite(dump.slot);
      if (tradeSlot == null || dumpSlot == null || tradeSlot < dumpSlot) continue;
      if (tradeSlot === dumpSlot) {
        if (causallyAfter(trade, dump.signalTrade)) state.trades.push(trade);
        continue;
      }
      state.trades.push(trade);
      changed.push(...this._finalizeEpisode(state));
      for (const buffered of state.trades) {
        changed.push(...this._processExitTrade(buffered, new Set([episodeId])));
      }
      finalizedNow.add(episodeId);
    }
    changed.push(...this._processExitTrade(trade, null, finalizedNow));
    return changed;
  }

  _processExitTrade(trade, onlyEpisodes = null, skipEpisodes = new Set()) {
    const changed = [];
    const ids = this.simulationsByPool.get(trade.pool);
    if (!ids?.size) return changed;
    const at = finite(trade.receivedAtMs ?? trade.timestampMs, this.now());
    for (const shadowId of [...ids]) {
      const simulation = this.simulations.get(shadowId);
      if (!simulation || simulation.status !== 'PENDING_EXIT') continue;
      if (onlyEpisodes && !onlyEpisodes.has(simulation.episodeId)) continue;
      if (skipEpisodes.has(simulation.episodeId)) continue;
      if (!sameAsset(simulation.dump, trade)) continue;
      this._advanceExpiredExitPhases(simulation, at);
      if (simulation.status !== 'PENDING_EXIT' || at < simulation.activeExitTargetAtMs) continue;
      if (!causallyAfter(trade, simulation.entryReferenceOrder)) continue;
      simulation.postHorizonTrades += 1;
      const sell = quoteSell(trade, simulation.tokenUnits, {
        slippageBps: this.config.sellSlippageBps,
      });
      const exitQuality = assessTradeDataQuality(
        trade, this.config, simulation.entryReferenceTrade,
      );
      if (exitQuality.status !== 'TRUSTED') {
        simulation.status = 'NO_EXIT';
        simulation.rejectionReason = 'DATA_QUALITY_REJECTED_EXIT';
        simulation.dataQualityStatus = 'QUARANTINED';
        simulation.dataQualityReasons = [
          ...(simulation.dataQualityReasons || []), ...exitQuality.reasons,
        ];
        simulation.updatedAtMs = at;
        this.metrics.noExit += 1;
        this.metrics.dataQualityQuarantined += 1;
        simulation.exitReason = 'DATA_QUALITY_REJECTED_EXIT';
        this._finish(simulation);
        this.store?.updateSameSlotShadow?.(simulation);
        changed.push(simulation);
        continue;
      }
      if (!sell.available) {
        simulation.updatedAtMs = at;
        this.store?.updateSameSlotShadow?.(simulation);
        changed.push(simulation);
        continue;
      }
      this._close(simulation, trade, at, sell);
      changed.push(simulation);
    }
    return changed;
  }

  advanceTime(now = this.now()) {
    const changed = [];
    const retentionMs = Math.max(1, finite(this.config.episodeRetentionMs, 5_000));
    for (const state of [...this.episodes.values()]) {
      if (now - state.dump.detectedAtMs <= retentionMs) continue;
      changed.push(...this._finalizeEpisode(state));
      for (const buffered of state.trades) {
        changed.push(...this._processExitTrade(buffered, new Set([state.dump.episodeId])));
      }
    }
    for (const simulation of this.simulations.values()) {
      if (simulation.status !== 'PENDING_EXIT' || now <= simulation.activeExitDeadlineAtMs) continue;
      if (this._advanceExpiredExitPhases(simulation, now)) changed.push(simulation);
    }
    return changed;
  }

  _phaseNoExitReason(simulation) {
    return simulation.postHorizonTrades > 0
      ? 'NO_CAUSAL_EXIT_QUOTE' : 'NO_TRADE_AT_OR_AFTER_EXIT_HORIZON';
  }

  _advanceExpiredExitPhases(simulation, now) {
    let changed = false;
    while (simulation.status === 'PENDING_EXIT' && now > simulation.activeExitDeadlineAtMs) {
      const reason = this._phaseNoExitReason(simulation);
      if (simulation.exitPhase === 'PRIMARY') {
        simulation.primaryNoExitReason = reason;
      } else if (simulation.activeRescueHorizonMs != null) {
        simulation.rescueAttemptedHorizons = [...new Set([
          ...(simulation.rescueAttemptedHorizons || []), simulation.activeRescueHorizonMs,
        ])];
      }
      const currentHorizonMs = simulation.activeRescueHorizonMs || 0;
      const nextHorizonMs = this.rescueHorizonsMs.find((value) => value > currentHorizonMs);
      if (nextHorizonMs != null) {
        if (simulation.exitPhase === 'PRIMARY') this.metrics.rescueStarted += 1;
        simulation.exitPhase = `RESCUE_${nextHorizonMs}`;
        simulation.activeRescueHorizonMs = nextHorizonMs;
        simulation.activeExitTargetAtMs = simulation.entryAtMs + nextHorizonMs;
        simulation.activeExitDeadlineAtMs = simulation.activeExitTargetAtMs
          + Math.max(100, finite(this.config.rescueTimeoutMs, 2_000));
        simulation.postHorizonTrades = 0;
        simulation.updatedAtMs = now;
        changed = true;
        continue;
      }
      simulation.status = 'NO_EXIT';
      simulation.rejectionReason = reason;
      simulation.exitReason = this.rescueHorizonsMs.length
        ? 'RESCUE_EXHAUSTED' : 'PRIMARY_EXIT_EXHAUSTED';
      simulation.updatedAtMs = now;
      this.metrics.noExit += 1;
      if (this.rescueHorizonsMs.length) this.metrics.rescueUnresolved += 1;
      this._finish(simulation);
      changed = true;
    }
    if (changed) this.store?.updateSameSlotShadow?.(simulation);
    return changed;
  }

  _finalizeEpisode(state) {
    if (!state || state.finalized) return [];
    state.finalized = true;
    const dump = state.dump;
    const strictBuys = state.trades.filter((trade) => trade.side === 'BUY'
      && finite(trade.slot) === finite(dump.slot)
      && causallyAfter(trade, dump.signalTrade)).sort((left, right) => (
      finite(left.transactionIndex, Infinity) - finite(right.transactionIndex, Infinity)
      || finite(left.instructionIndex, Infinity) - finite(right.instructionIndex, Infinity)
      || finite(left.eventIndex, Infinity) - finite(right.eventIndex, Infinity)
    ));
    const created = this._scheduleRank({
      dump,
      targetRank: 1,
      entryProfileId: 'R1-RAW',
      entryReferenceTrade: dump.signalTrade,
      entryAtMs: dump.detectedAtMs,
      entryAssumption: 'THEORETICAL_RANK_1_POST_DUMP_STATE',
      entryReferenceRank: 0,
      triggerTrade: null,
      cohortStage: 'CONTROL',
      quality: state.dataQuality,
    });
    if (strictBuys[0]) {
      const firstBuyAtMs = finite(
        strictBuys[0].receivedAtMs ?? strictBuys[0].timestampMs,
        dump.detectedAtMs,
      );
      const triggerBuySol = finite(strictBuys[0].solAmount, 0);
      const rank2ProfileId = triggerBuySol >= this.config.strongRank2TriggerBuySol
        ? 'R2-B5'
        : (triggerBuySol >= this.config.minRank2TriggerBuySol ? 'R2-B2' : 'R2-BASE');
      const cohortStage = rank2ProfileId === this.config.primaryProfileId
        ? this.config.primaryCohortStage : 'CONTROL';
      const rank2Quality = assessTradeDataQuality(
        strictBuys[0], this.config, dump.signalTrade,
      );
      const combinedQuality = {
        status: state.dataQuality.status === 'TRUSTED' && rank2Quality.status === 'TRUSTED'
          ? 'TRUSTED' : 'QUARANTINED',
        reasons: [...new Set([...state.dataQuality.reasons, ...rank2Quality.reasons])],
      };
      created.push(...this._scheduleRank({
        dump,
        targetRank: 2,
        entryProfileId: rank2ProfileId,
        entryReferenceTrade: strictBuys[0],
        entryAtMs: firstBuyAtMs,
        entryAssumption: 'THEORETICAL_RANK_2_AFTER_OBSERVED_RANK_1',
        entryReferenceRank: 1,
        triggerTrade: strictBuys[0],
        cohortStage,
        quality: combinedQuality,
      }));
      this._recordCompetitor({
        episodeId: dump.episodeId,
        targetRank: 1,
        trade: strictBuys[0],
        dumpDetectedAtMs: dump.detectedAtMs,
        referenceAtMs: dump.detectedAtMs,
      });
    }
    if (strictBuys[1]) {
      this._recordCompetitor({
        episodeId: dump.episodeId,
        targetRank: 2,
        trade: strictBuys[1],
        dumpDetectedAtMs: dump.detectedAtMs,
        referenceAtMs: finite(
          strictBuys[0].receivedAtMs ?? strictBuys[0].timestampMs,
          dump.detectedAtMs,
        ),
      });
    }
    for (const simulation of created) {
      if (simulation.status === 'NO_ENTRY') this.simulations.delete(simulation.shadowId);
    }
    this._removeEpisode(dump.episodeId, dump.pool);
    return created;
  }

  _scheduleRank({
    dump, targetRank, entryProfileId, entryReferenceTrade, entryAtMs, entryAssumption,
    entryReferenceRank, triggerTrade, cohortStage, quality,
  }) {
    if (!this.config.targetRanks.includes(targetRank)) return [];
    const created = [];
    for (const positionSol of this.config.positionSizesSol) {
      const capacity = quoteImmediateRoundTrip(entryReferenceTrade, positionSol, {
        buySlippageBps: this.config.buySlippageBps,
        sellSlippageBps: this.config.sellSlippageBps,
      });
      const capacityNetProceedsSol = capacity.available
        ? capacity.proceedsSol - this.txFeeSol * 2 : null;
      const capacityRoundTripLossPct = capacity.available
        ? Math.max(0, (1 - capacityNetProceedsSol / positionSol) * 100) : null;
      let rejectionReason = capacity.available ? null : capacity.reason;
      if (quality.status !== 'TRUSTED') {
        rejectionReason = 'DATA_QUALITY_REJECTED_ENTRY';
        this.metrics.dataQualityQuarantined += this.config.exitHorizonsMs.length;
      }
      if (!rejectionReason && (
        capacity.entryLiquidityUsagePct > this.config.maxEntryLiquidityUsagePct
        || capacity.exitLiquidityUsagePct > this.config.maxExitLiquidityUsagePct
      )) {
        rejectionReason = 'INSUFFICIENT_ROUND_TRIP_LIQUIDITY';
        this.metrics.insufficientRoundTripLiquidity += this.config.exitHorizonsMs.length;
      }
      if (!rejectionReason
        && capacityRoundTripLossPct > this.config.maxImmediateRoundTripLossPct) {
        rejectionReason = 'ROUND_TRIP_COST_TOO_HIGH';
        this.metrics.roundTripCostTooHigh += this.config.exitHorizonsMs.length;
      }
      for (const exitHorizonMs of this.config.exitHorizonsMs) {
        const shadowId = [
          dump.episodeId, `R${targetRank}`, positionSol.toFixed(3), `X${exitHorizonMs}`,
        ].join(':');
        if (this.simulations.has(shadowId)) continue;
        const now = this.now();
        const buy = capacity.buy || {};
        const simulation = {
          shadowId,
          episodeId: dump.episodeId,
          targetRank,
          entryProfileId,
          cohortStage: cohortStage || 'CONTROL',
          positionSol,
          exitHorizonMs,
          quoteModel: this.config.quoteModel,
          status: rejectionReason ? 'NO_ENTRY' : 'PENDING_EXIT',
          rejectionReason,
          infrastructureMode: 'THEORETICAL_ONLY',
          infrastructureExecutable: false,
          infrastructureReason: 'POST_EXECUTION_STREAM_NO_LANDING_GUARANTEE',
          parseBudgetMs: this.config.parseBudgetMs,
          buildBudgetMs: this.config.buildBudgetMs,
          signBudgetMs: this.config.signBudgetMs,
          sendBudgetMs: this.config.sendBudgetMs,
          responseBudgetMs: this.responseBudgetMs,
          latencyModel: 'ENTRY_REFERENCE_TO_NEXT_COMPETITOR_V2',
          competitorObservedAtMs: null,
          competitorReceiveLagMs: null,
          competitorReferenceAtMs: null,
          competitorGapMs: null,
          competitorHeadroomMs: null,
          triggerBuySol: finite(triggerTrade?.solAmount),
          triggerBuyToDumpPct: pct(finite(triggerTrade?.solAmount, 0), finite(dump.sellSol, 0)),
          triggerWallet: triggerTrade?.wallet || null,
          dataQualityStatus: quality.status,
          dataQualityReasons: quality.reasons,
          entryAssumption,
          entryReferenceRank,
          entryAtMs,
          entrySlot: entryReferenceTrade.slot ?? null,
          entryReferenceSignature: entryReferenceTrade.signature || null,
          entryReferenceTransactionIndex: finite(entryReferenceTrade.transactionIndex),
          entryReferenceInstructionIndex: finite(entryReferenceTrade.instructionIndex),
          entryReferenceEventIndex: finite(entryReferenceTrade.eventIndex, 0),
          entryReferenceOrder: {
            slot: entryReferenceTrade.slot,
            transactionIndex: entryReferenceTrade.transactionIndex,
            instructionIndex: entryReferenceTrade.instructionIndex,
            eventIndex: entryReferenceTrade.eventIndex,
          },
          entryPrice: buy.price ?? null,
          entryMarketPrice: buy.marketPrice ?? null,
          entryImpactPct: buy.impactPct ?? null,
          entryTotalFeeBps: buy.totalFeeBps ?? null,
          entryLiquidityUsagePct: buy.liquidityUsagePct ?? null,
          entryCapacityRoundTripLossPct: capacityRoundTripLossPct,
          entryCapacityExitLiquidityUsagePct: capacity.exitLiquidityUsagePct ?? null,
          tokenUnits: buy.tokenUnits ?? null,
          entryReserveSource: buy.reserveSource ?? null,
          entryFeeSol: this.txFeeSol,
          exitFeeSol: this.txFeeSol,
          modeledJitoTipSol: Math.max(0, finite(this.config.jitoTipSol, 0)),
          requestedExitAtMs: entryAtMs + exitHorizonMs,
          exitDeadlineAtMs: entryAtMs + exitHorizonMs + this.config.exitTimeoutMs,
          activeExitTargetAtMs: entryAtMs + exitHorizonMs,
          activeExitDeadlineAtMs: entryAtMs + exitHorizonMs + this.config.exitTimeoutMs,
          exitPhase: 'PRIMARY',
          activeRescueHorizonMs: null,
          rescueHorizonMs: null,
          rescueAttemptedHorizons: [],
          primaryNoExitReason: null,
          exitReason: null,
          postHorizonTrades: 0,
          dump,
          entryReferenceTrade,
          createdAtMs: now,
          updatedAtMs: now,
        };
        this.simulations.set(shadowId, simulation);
        this.metrics.scheduled += 1;
        if (rejectionReason) {
          this.metrics.noEntry += 1;
        } else {
          const ids = this.simulationsByPool.get(dump.pool) || new Set();
          ids.add(shadowId);
          this.simulationsByPool.set(dump.pool, ids);
          this.metrics.entryFilled += 1;
          if (targetRank === 1) this.metrics.rank1Entries += 1;
          if (targetRank === 2) this.metrics.rank2Entries += 1;
          if (entryProfileId === 'R2-B2') this.metrics.rank2B2Entries += 1;
          if (entryProfileId === 'R2-B5') this.metrics.rank2B5Entries += 1;
        }
        this.store?.insertSameSlotShadow?.(simulation);
        created.push(simulation);
      }
    }
    return created;
  }

  _recordCompetitor({
    episodeId, targetRank, trade, dumpDetectedAtMs, referenceAtMs,
  }) {
    const observedAtMs = finite(trade.receivedAtMs ?? trade.timestampMs, this.now());
    const receiveLagMs = Math.max(0, observedAtMs - dumpDetectedAtMs);
    const gapMs = observedAtMs - referenceAtMs;
    for (const simulation of this.simulations.values()) {
      if (simulation.episodeId !== episodeId || simulation.targetRank !== targetRank) continue;
      simulation.competitorObservedAtMs = observedAtMs;
      simulation.competitorReceiveLagMs = receiveLagMs;
      simulation.competitorReferenceAtMs = referenceAtMs;
      simulation.competitorGapMs = gapMs;
      simulation.competitorHeadroomMs = gapMs - this.responseBudgetMs;
      simulation.updatedAtMs = observedAtMs;
      this.store?.updateSameSlotShadow?.(simulation);
    }
  }

  _close(simulation, trade, at, sell) {
    const totalCostSol = simulation.entryFeeSol + simulation.exitFeeSol;
    const rescueHorizonMs = simulation.exitPhase === 'PRIMARY'
      ? null : simulation.activeRescueHorizonMs;
    if (rescueHorizonMs != null) {
      simulation.rescueAttemptedHorizons = [...new Set([
        ...(simulation.rescueAttemptedHorizons || []), rescueHorizonMs,
      ])];
      if (rescueHorizonMs === 5_000) this.metrics.rescue5sFilled += 1;
      if (rescueHorizonMs === 10_000) this.metrics.rescue10sFilled += 1;
    }
    Object.assign(simulation, {
      status: 'CLOSED',
      rejectionReason: null,
      exitReason: rescueHorizonMs == null ? 'PRIMARY' : `RESCUE_${rescueHorizonMs}`,
      rescueHorizonMs,
      exitAtMs: at,
      exitSlot: trade.slot ?? null,
      exitSignature: trade.signature || null,
      exitQuoteLagMs: Math.max(0, at - simulation.activeExitTargetAtMs),
      exitPrice: sell.price,
      exitMarketPrice: sell.marketPrice,
      exitImpactPct: sell.impactPct,
      exitTotalFeeBps: sell.totalFeeBps,
      exitLiquidityUsagePct: sell.liquidityUsagePct,
      exitReserveSource: sell.reserveSource,
      proceedsSol: sell.proceedsSol,
      totalCostSol,
      grossReturnPct: (sell.proceedsSol / simulation.positionSol - 1) * 100,
      netReturnPct: ((sell.proceedsSol - totalCostSol) / simulation.positionSol - 1) * 100,
      holdMs: at - simulation.entryAtMs,
      updatedAtMs: at,
    });
    this.metrics.exitFilled += 1;
    this._finish(simulation);
    this.store?.updateSameSlotShadow?.(simulation);
  }

  _finish(simulation) {
    const ids = this.simulationsByPool.get(simulation.dump.pool);
    if (ids) {
      ids.delete(simulation.shadowId);
      if (!ids.size) this.simulationsByPool.delete(simulation.dump.pool);
    }
    this.simulations.delete(simulation.shadowId);
  }

  _removeEpisode(episodeId, pool) {
    this.episodes.delete(episodeId);
    const ids = this.episodesByPool.get(pool);
    if (!ids) return;
    ids.delete(episodeId);
    if (!ids.size) this.episodesByPool.delete(pool);
  }

  isTrackingPool(pool) {
    return Boolean(pool
      && (this.episodesByPool.has(pool) || this.simulationsByPool.has(pool)));
  }

  health() {
    const active = [...this.simulations.values()]
      .filter((row) => row.status === 'PENDING_EXIT').length;
    return {
      enabled: this.config.enabled,
      activeSimulations: active,
      activeEpisodes: this.episodes.size,
      quoteModel: this.config.quoteModel,
      responseBudgetMs: this.responseBudgetMs,
      sendsTransactions: false,
      ...this.metrics,
    };
  }
}

module.exports = { SameSlotShadowSimulator };
