'use strict';

const { effectiveReserves, reservePrice } = require('./AmmQuote');
const { strictlyAfter } = require('./SlotAssembler');
const { assessTradeDataQuality } = require('./TradeDataQuality');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function pct(part, whole) {
  return whole > 0 ? part / whole * 100 : null;
}

function sameAsset(dump, trade) {
  if (!dump || !trade || dump.pool !== trade.pool || dump.mint !== trade.mint) return false;
  const dumpDecimals = finite(dump.signalTrade?.tokenDecimals);
  const tradeDecimals = finite(trade.tokenDecimals);
  return dumpDecimals == null || tradeDecimals == null || dumpDecimals === tradeDecimals;
}

function recoveryPct(dump, currentPrice) {
  const low = finite(dump?.lowPrice);
  const pre = finite(dump?.prePrice);
  if (!(currentPrice > 0) || !(low > 0) || !(pre > low)) return null;
  return (currentPrice - low) / (pre - low) * 100;
}

/**
 * Freezes forward-only validation cohorts around the first strictly ordered
 * public PumpSwap buy after a dump.  The trigger trade is never used as the
 * entry quote: ExecutionSimulator must wait for a later causal reserve sample.
 */
class CausalBackrunConfirmer {
  constructor({ config, executionConfig, dataQualityConfig, executionProbe = null,
    now = () => Date.now() }) {
    this.config = config || { enabled: false, profiles: [] };
    this.executionConfig = executionConfig || {};
    this.dataQualityConfig = dataQualityConfig || null;
    this.executionProbe = executionProbe;
    this.now = now;
    this.episodes = new Map();
    this.byPool = new Map();
    this.metrics = {
      tracked: 0,
      toxicSkipped: 0,
      firstStrictBuys: 0,
      qualityRejected: 0,
      belowThreshold: 0,
      confirmations: 0,
      expiredWithoutSameSlotBuy: 0,
    };
  }

  startEpisode(dump, toxic = {}) {
    if (!this.config.enabled || !dump?.episodeId || !dump.pool || !dump.signalTrade) return;
    if (toxic.rejected) {
      this.metrics.toxicSkipped += 1;
      return;
    }
    const dumpQuality = assessTradeDataQuality(dump.signalTrade, this.dataQualityConfig);
    if (dumpQuality.status !== 'TRUSTED') {
      this.metrics.qualityRejected += 1;
      return;
    }
    this.episodes.set(dump.episodeId, { dump, dumpQuality });
    const ids = this.byPool.get(dump.pool) || new Set();
    ids.add(dump.episodeId);
    this.byPool.set(dump.pool, ids);
    this.metrics.tracked += 1;
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.pool) return [];
    const confirmations = [];
    const ids = this.byPool.get(trade.pool);
    for (const episodeId of [...(ids || [])]) {
      const state = this.episodes.get(episodeId);
      const dump = state?.dump;
      if (!state || !sameAsset(dump, trade)) continue;
      const tradeSlot = finite(trade.slot);
      const dumpSlot = finite(dump.slot);
      if (tradeSlot == null || dumpSlot == null || tradeSlot < dumpSlot) continue;
      if (tradeSlot > dumpSlot) {
        this.metrics.expiredWithoutSameSlotBuy += 1;
        this._remove(episodeId, dump.pool);
        continue;
      }
      if (trade.side !== 'BUY' || strictlyAfter(trade, dump.signalTrade) !== true) continue;

      // This is deliberately the first strict public BUY.  If it is dust or
      // fails a frozen threshold, a later buy may not replace it.
      this.metrics.firstStrictBuys += 1;
      this._remove(episodeId, dump.pool);
      const triggerQuality = assessTradeDataQuality(
        trade, this.dataQualityConfig, dump.signalTrade,
      );
      if (triggerQuality.status !== 'TRUSTED') {
        this.metrics.qualityRejected += 1;
        continue;
      }
      const matched = this.config.profiles.filter((profile) => (
        finite(trade.solAmount, 0) >= profile.minFirstBuySol
        && finite(dump.dropPct, Infinity) >= profile.minDropPct
        && finite(dump.dropPct, -Infinity) <= profile.maxDropPct
      ));
      if (!matched.length) {
        this.metrics.belowThreshold += 1;
        continue;
      }
      for (const profile of matched) confirmations.push(this._confirmation(profile, dump, trade));
    }
    return confirmations;
  }

  _confirmation(profile, dump, trade) {
    const confirmedAtMs = finite(trade.receivedAtMs ?? trade.timestampMs, this.now());
    const currentPrice = reservePrice(trade);
    const reserves = effectiveReserves(trade);
    const currentQuoteSol = reserves ? Number(reserves.quoteRaw) / 1e9 : null;
    const triggerBuySol = finite(trade.solAmount, 0);
    const confirmation = {
      confirmationId: `${dump.episodeId}:${profile.id}`,
      episodeId: dump.episodeId,
      profileId: profile.id,
      confirmedAtMs,
      slot: trade.slot ?? null,
      transactionIndex: trade.transactionIndex ?? null,
      instructionIndex: trade.instructionIndex ?? null,
      eventIndex: trade.eventIndex ?? null,
      signature: trade.signature || null,
      orderingConfidence: 'STRICT',
      dump,
      allowSameSlotTrigger: true,
      entryReferenceTrade: trade,
      entryDataQualityConfig: this.dataQualityConfig,
      executionPlan: {
        ...this.executionConfig,
        entryVariants: this.config.entryVariants,
        positionSizesSol: this.config.positionSizesSol,
        exitProfiles: this.config.exitProfiles,
        combinationGrid: this.config.combinationGrid,
        entryTimeoutMs: this.config.entryTimeoutMs,
        exitDelayMs: 0,
        exitTimeoutMs: this.config.exitTimeoutMs,
        exitGraceMs: this.config.exitGraceMs,
        quoteModel: this.config.quoteModel,
      },
      snapshot: {
        slotDelta: 0,
        currentPrice,
        lowPrice: dump.lowPrice,
        priceBouncePct: currentPrice > 0 && dump.lowPrice > 0
          ? (currentPrice / dump.lowPrice - 1) * 100 : null,
        dropRecoveryPct: recoveryPct(dump, currentPrice),
        validBuySol: triggerBuySol,
        uniqueBuyers: trade.wallet ? 1 : 0,
        buyToDumpPct: pct(triggerBuySol, finite(dump.sellSol, 0)),
        netFlowSol: triggerBuySol,
        netFlow1sSol: null,
        netFlow3sSol: null,
        currentQuoteSol,
        absorptionScore: null,
        absorptionScoreComponents: null,
        researchKind: 'FROZEN_CAUSAL_BACKRUN_V1',
        firstPublicBuyRequired: true,
        triggerBuySol,
        triggerWallet: trade.wallet || null,
        triggerSignature: trade.signature || null,
        minFirstBuySol: profile.minFirstBuySol,
        minDropPct: profile.minDropPct,
        maxDropPct: profile.maxDropPct,
        postQuoteGate: null,
        futureTradeGate: null,
      },
    };
    const probeInput = {
      episodeId: dump.episodeId,
      shadowId: null,
      candidatePrimary: true,
      candidateProfileId: profile.id,
      candidateCohortStage: 'FROZEN_FORWARD_V1',
      entryAtMs: confirmedAtMs,
      entryReferenceSignature: trade.signature || null,
      triggerSignature: trade.signature || null,
    };
    this.executionProbe?.measure?.(probeInput);
    this.executionProbe?.finalize?.(probeInput);
    this.metrics.confirmations += 1;
    return confirmation;
  }

  advanceTime(now = this.now()) {
    const retentionMs = finite(this.config.triggerRetentionMs, 2_000);
    for (const [episodeId, state] of [...this.episodes.entries()]) {
      if (now - state.dump.detectedAtMs <= retentionMs) continue;
      this.metrics.expiredWithoutSameSlotBuy += 1;
      this._remove(episodeId, state.dump.pool);
    }
  }

  _remove(episodeId, pool) {
    this.episodes.delete(episodeId);
    const ids = this.byPool.get(pool);
    if (!ids) return;
    ids.delete(episodeId);
    if (!ids.size) this.byPool.delete(pool);
  }

  isTrackingPool(pool) {
    return Boolean(pool && this.byPool.has(pool));
  }

  health() {
    return {
      enabled: Boolean(this.config.enabled),
      mode: 'FROZEN_FORWARD_ONLY_NO_SEND',
      sendsTransactions: false,
      activeEpisodes: this.episodes.size,
      activePools: this.byPool.size,
      profiles: this.config.profiles?.map((profile) => profile.id) || [],
      ...this.metrics,
    };
  }
}

module.exports = { CausalBackrunConfirmer };
