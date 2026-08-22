'use strict';

const {
  quoteImmediateRoundTrip, quoteSell, transactionFeeSol,
} = require('./AmmQuote');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class ExecutionSimulator {
  constructor({ config, store = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.simulations = new Map();
    this.byPool = new Map();
    this.txFeeSol = transactionFeeSol(config);
    this.metrics = {
      scheduled: 0,
      entryFilled: 0,
      noEntry: 0,
      exitFilled: 0,
      noExit: 0,
      blockedSameSlot: 0,
      invalidatedBeforeEntry: 0,
      insufficientRoundTripLiquidity: 0,
      roundTripCostTooHigh: 0,
    };
  }

  schedule(confirmation) {
    const created = [];
    if (!(Number(confirmation?.snapshot?.slotDelta) > 0)) {
      this.metrics.blockedSameSlot += 1;
      return created;
    }
    for (const entry of this.config.entryVariants) {
      for (const positionSol of this.config.positionSizesSol) {
        for (const exit of this.config.exitProfiles) {
          const simulationId = [
            confirmation.confirmationId,
            entry.id,
            positionSol.toFixed(3),
            exit.id,
          ].join(':');
          if (this.simulations.has(simulationId)) continue;
          const requestedEntryAtMs = confirmation.confirmedAtMs + entry.delayMs;
          const simulation = {
            simulationId,
            confirmationId: confirmation.confirmationId,
            episodeId: confirmation.episodeId,
            recoveryProfileId: confirmation.profileId,
            entryVariantId: entry.id,
            entryKind: entry.kind,
            entryDelayMs: entry.delayMs,
            exitProfileId: exit.id,
            exitProfile: exit,
            positionSol,
            quoteModel: this.config.quoteModel,
            status: 'PENDING_ENTRY',
            rejectionReason: null,
            confirmedAtMs: confirmation.confirmedAtMs,
            confirmationSlot: confirmation.slot,
            requestedEntryAtMs,
            entryDeadlineAtMs: confirmation.confirmedAtMs + this.config.entryTimeoutMs,
            dump: confirmation.dump,
            entryFeeSol: this.txFeeSol,
            exitFeeSol: this.txFeeSol,
            failedTransactionFeeSol: 0,
            mfeNetPct: null,
            maeNetPct: null,
            createdAtMs: this.now(),
            updatedAtMs: this.now(),
          };
          this.simulations.set(simulationId, simulation);
          const ids = this.byPool.get(confirmation.dump.pool) || new Set();
          ids.add(simulationId);
          this.byPool.set(confirmation.dump.pool, ids);
          this.store?.insertSimulation?.(simulation);
          this.metrics.scheduled += 1;
          created.push(simulation);
        }
      }
    }
    return created;
  }

  observeTrade(trade, recoveryUpdates = []) {
    const ids = this.byPool.get(trade?.pool);
    if (!ids?.size) return [];
    const updatesByEpisode = new Map(recoveryUpdates.map((row) => [row.episodeId, row]));
    const changed = [];
    const at = finite(trade.receivedAtMs ?? trade.timestampMs, this.now());
    for (const simulationId of [...ids]) {
      const simulation = this.simulations.get(simulationId);
      if (!simulation || simulation.dump.mint !== trade.mint) continue;
      const recovery = updatesByEpisode.get(simulation.episodeId);
      if (simulation.status === 'PENDING_ENTRY') {
        if (recovery?.secondDump || recovery?.status === 'SECOND_DUMP') {
          this._rejectEntry(simulation, 'RECOVERY_INVALIDATED_BEFORE_ENTRY', at);
          this.metrics.invalidatedBeforeEntry += 1;
          changed.push(simulation);
          continue;
        }
        if (!this._entryEligible(simulation, trade, at)) continue;
        const capacity = quoteImmediateRoundTrip(trade, simulation.positionSol, {
          buySlippageBps: this.config.buySlippageBps,
          sellSlippageBps: this.config.sellSlippageBps,
        });
        if (!capacity.available) continue;
        const capacityNetProceedsSol = capacity.proceedsSol - this.txFeeSol * 2;
        const capacityRoundTripLossPct = Math.max(
          0,
          (1 - capacityNetProceedsSol / simulation.positionSol) * 100,
        );
        Object.assign(simulation, {
          entryCapacityRoundTripLossPct: capacityRoundTripLossPct,
          entryCapacityExitLiquidityUsagePct: capacity.exitLiquidityUsagePct,
        });
        const maxEntryUsage = finite(this.config.maxEntryLiquidityUsagePct, Infinity);
        const maxExitUsage = finite(this.config.maxExitLiquidityUsagePct, Infinity);
        if (capacity.entryLiquidityUsagePct > maxEntryUsage
          || capacity.exitLiquidityUsagePct > maxExitUsage) {
          this._rejectEntry(simulation, 'INSUFFICIENT_ROUND_TRIP_LIQUIDITY', at);
          this.metrics.insufficientRoundTripLiquidity += 1;
          changed.push(simulation);
          continue;
        }
        const maxRoundTripLoss = finite(this.config.maxImmediateRoundTripLossPct, Infinity);
        if (capacityRoundTripLossPct > maxRoundTripLoss) {
          this._rejectEntry(simulation, 'ROUND_TRIP_COST_TOO_HIGH', at);
          this.metrics.roundTripCostTooHigh += 1;
          changed.push(simulation);
          continue;
        }
        const buy = capacity.buy;
        Object.assign(simulation, {
          status: 'OPEN',
          entryAtMs: at,
          entrySlot: trade.slot ?? null,
          entrySignature: trade.signature || null,
          entryQuoteLagMs: Math.max(0, at - simulation.requestedEntryAtMs),
          actualEntryDelayMs: Math.max(0, at - simulation.confirmedAtMs),
          entryPrice: buy.price,
          entryMarketPrice: buy.marketPrice,
          entryImpactPct: buy.impactPct,
          entryProtocolFeeBps: buy.protocolFeeBps,
          entryTotalFeeBps: buy.totalFeeBps,
          entryLiquidityUsagePct: buy.liquidityUsagePct,
          tokenUnits: buy.tokenUnits,
          entryReserveSource: buy.reserveSource,
          maxExitAtMs: at + this._maxHoldMs(simulation.exitProfile),
          updatedAtMs: at,
        });
        this.metrics.entryFilled += 1;
        this.store?.updateSimulation?.(simulation);
        changed.push(simulation);
        continue;
      }

      if (simulation.status === 'PENDING_EXIT') {
        if (at < simulation.requestedExitAtMs) continue;
        const sell = quoteSell(trade, simulation.tokenUnits, {
          slippageBps: this.config.sellSlippageBps,
        });
        if (!sell.available) continue;
        this._close(simulation, trade, at, sell);
        changed.push(simulation);
        continue;
      }

      if (simulation.status !== 'OPEN' || at <= simulation.entryAtMs) continue;
      const sell = quoteSell(trade, simulation.tokenUnits, {
        slippageBps: this.config.sellSlippageBps,
      });
      if (!sell.available) continue;
      const returns = this._returns(simulation, sell.proceedsSol);
      simulation.mfeNetPct = simulation.mfeNetPct == null
        ? returns.netReturnPct : Math.max(simulation.mfeNetPct, returns.netReturnPct);
      simulation.maeNetPct = simulation.maeNetPct == null
        ? returns.netReturnPct : Math.min(simulation.maeNetPct, returns.netReturnPct);
      simulation.lastExecutableNetPct = returns.netReturnPct;
      simulation.lastExecutableQuoteAtMs = at;
      simulation.updatedAtMs = at;
      const reason = this._exitReason(simulation, recovery, returns.netReturnPct, at);
      if (reason) this._triggerExit(simulation, reason, at);
      this.store?.updateSimulation?.(simulation);
      changed.push(simulation);
    }
    return changed;
  }

  advanceTime(now = this.now()) {
    const changed = [];
    for (const simulation of this.simulations.values()) {
      if (simulation.status === 'PENDING_ENTRY' && now > simulation.entryDeadlineAtMs) {
        simulation.status = 'NO_ENTRY';
        simulation.rejectionReason = 'NO_CAUSAL_ENTRY_QUOTE';
        simulation.updatedAtMs = now;
        this.metrics.noEntry += 1;
        this._finish(simulation);
        changed.push(simulation);
      } else if (simulation.status === 'PENDING_EXIT' && now > simulation.exitDeadlineAtMs) {
        simulation.status = 'NO_EXIT';
        simulation.rejectionReason = 'NO_CAUSAL_EXIT_QUOTE';
        simulation.updatedAtMs = now;
        this.metrics.noExit += 1;
        this._finish(simulation);
        changed.push(simulation);
      } else if (simulation.status === 'OPEN'
        && now > simulation.maxExitAtMs + this.config.exitGraceMs) {
        simulation.status = 'NO_EXIT';
        simulation.rejectionReason = 'NO_TRADE_AT_OR_AFTER_EXIT_HORIZON';
        simulation.exitTargetAtMs = simulation.maxExitAtMs;
        simulation.updatedAtMs = now;
        this.metrics.noExit += 1;
        this._finish(simulation);
        changed.push(simulation);
      }
    }
    for (const simulation of changed) this.store?.updateSimulation?.(simulation);
    return changed;
  }

  _entryEligible(simulation, trade, at) {
    if (at > simulation.entryDeadlineAtMs) return false;
    if (simulation.entryKind === 'NEXT_SLOT') {
      return finite(trade.slot, -Infinity) > finite(simulation.confirmationSlot, Infinity);
    }
    return at >= simulation.requestedEntryAtMs;
  }

  _exitReason(simulation, recovery, netReturnPct, at) {
    const profile = simulation.exitProfile;
    if (recovery?.secondDump) return 'SECOND_DUMP';
    if (profile.stopLossPct != null && netReturnPct <= profile.stopLossPct) return 'EXECUTABLE_STOP_LOSS';
    if (profile.kind === 'RECOVERY' && recovery) {
      const target = simulation.dump.lowPrice
        + (simulation.dump.prePrice - simulation.dump.lowPrice) * profile.recoveryPct / 100;
      if (recovery.currentPrice >= target) return `RECOVERY_${profile.recoveryPct}`;
    }
    if (profile.flowExit && at - simulation.entryAtMs >= 1_000 && recovery?.netFlow1sSol < 0) {
      return 'NET_FLOW_1S_NEGATIVE';
    }
    if (profile.flowExit && recovery?.buyerStalled) return 'BUYER_GROWTH_STALLED';
    if (profile.kind === 'FIXED' && at >= simulation.entryAtMs + profile.holdMs) return 'FIXED_HOLD';
    if (at >= simulation.maxExitAtMs) return 'MAX_HOLD';
    return null;
  }

  _triggerExit(simulation, reason, at) {
    simulation.status = 'PENDING_EXIT';
    simulation.exitReason = reason;
    simulation.exitTriggeredAtMs = at;
    simulation.exitTargetAtMs = reason === 'FIXED_HOLD'
      ? simulation.entryAtMs + simulation.exitProfile.holdMs : at;
    simulation.requestedExitAtMs = at + this.config.exitDelayMs;
    simulation.exitDeadlineAtMs = simulation.requestedExitAtMs + this.config.exitTimeoutMs;
    simulation.updatedAtMs = at;
  }

  _close(simulation, trade, at, sell) {
    const returns = this._returns(simulation, sell.proceedsSol);
    Object.assign(simulation, {
      status: 'CLOSED',
      exitAtMs: at,
      exitSlot: trade.slot ?? null,
      exitSignature: trade.signature || null,
      exitQuoteLagMs: Math.max(0, at - simulation.requestedExitAtMs),
      exitHorizonLagMs: Math.max(0, at - simulation.exitTargetAtMs),
      exitPrice: sell.price,
      exitMarketPrice: sell.marketPrice,
      exitImpactPct: sell.impactPct,
      exitProtocolFeeBps: sell.protocolFeeBps,
      exitTotalFeeBps: sell.totalFeeBps,
      exitLiquidityUsagePct: sell.liquidityUsagePct,
      exitReserveSource: sell.reserveSource,
      proceedsSol: sell.proceedsSol,
      grossReturnPct: returns.grossReturnPct,
      netReturnPct: returns.netReturnPct,
      totalCostSol: returns.totalCostSol,
      holdMs: at - simulation.entryAtMs,
      updatedAtMs: at,
    });
    this.metrics.exitFilled += 1;
    this._finish(simulation);
  }

  _returns(simulation, proceedsSol) {
    const totalCostSol = simulation.entryFeeSol + simulation.exitFeeSol
      + finite(simulation.failedTransactionFeeSol, 0);
    return {
      totalCostSol,
      grossReturnPct: (proceedsSol / simulation.positionSol - 1) * 100,
      netReturnPct: ((proceedsSol - totalCostSol) / simulation.positionSol - 1) * 100,
    };
  }

  _maxHoldMs(profile) {
    return profile.holdMs || profile.maxHoldMs || 20_000;
  }

  _finish(simulation) {
    this.store?.updateSimulation?.(simulation);
    const ids = this.byPool.get(simulation.dump.pool);
    if (!ids) return;
    ids.delete(simulation.simulationId);
    if (!ids.size) this.byPool.delete(simulation.dump.pool);
  }

  _rejectEntry(simulation, reason, at) {
    simulation.status = 'NO_ENTRY';
    simulation.rejectionReason = reason;
    simulation.updatedAtMs = at;
    this.metrics.noEntry += 1;
    this._finish(simulation);
  }

  isTrackingPool(pool) {
    return Boolean(pool && this.byPool.has(pool));
  }

  health() {
    const active = [...this.simulations.values()]
      .filter((row) => ['PENDING_ENTRY', 'OPEN', 'PENDING_EXIT'].includes(row.status));
    return {
      activeSimulations: active.length,
      activePools: this.byPool.size,
      quoteModel: this.config.quoteModel,
      sendsTransactions: false,
      ...this.metrics,
    };
  }
}

module.exports = { ExecutionSimulator };
