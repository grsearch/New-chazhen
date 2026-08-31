'use strict';

const { assessTradeDataQuality } = require('./TradeDataQuality');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function within(value, minimum, maximum) {
  return value >= finite(minimum, -Infinity) && value < finite(maximum, Infinity);
}

/**
 * Creates forward-only research cohorts directly from a PumpSwap dump.
 * The dump transaction is only a reference point: ExecutionSimulator must
 * wait for a later strictly ordered public reserve sample before filling.
 */
class DumpBounceMatrix {
  constructor({ config, executionConfig, dataQualityConfig, now = () => Date.now() }) {
    this.config = config || { enabled: false, signalProfiles: [] };
    this.executionConfig = executionConfig || {};
    this.dataQualityConfig = dataQualityConfig || null;
    this.now = now;
    this.metrics = {
      observedDumps: 0,
      qualifiedDumps: 0,
      belowMatrixFloor: 0,
      qualityRejected: 0,
      confirmations: 0,
    };
  }

  confirm(dump, toxic = {}) {
    if (!this.config.enabled || !dump?.signalTrade || dump.signalTrade.market !== 'PUMP_AMM') {
      return [];
    }
    this.metrics.observedDumps += 1;
    const quality = assessTradeDataQuality(dump.signalTrade, this.dataQualityConfig);
    if (quality.status !== 'TRUSTED') {
      this.metrics.qualityRejected += 1;
      return [];
    }
    const profile = this.config.signalProfiles.find((candidate) => (
      within(finite(dump.sellSol, 0), candidate.minSellSol, candidate.maxSellSol)
      && within(finite(dump.dropPct, 0), candidate.minDropPct, candidate.maxDropPct)
    ));
    if (!profile) {
      this.metrics.belowMatrixFloor += 1;
      return [];
    }
    this.metrics.qualifiedDumps += 1;
    const confirmation = this._confirmation(profile, dump, toxic);
    this.metrics.confirmations += 1;
    return [confirmation];
  }

  _confirmation(profile, dump, toxic) {
    const confirmedAtMs = finite(dump.detectedAtMs, this.now());
    return {
      confirmationId: `${dump.episodeId}:${profile.id}`,
      episodeId: dump.episodeId,
      profileId: profile.id,
      confirmedAtMs,
      slot: dump.slot ?? null,
      transactionIndex: dump.transactionIndex ?? null,
      instructionIndex: dump.instructionIndex ?? null,
      eventIndex: dump.eventIndex ?? null,
      signature: dump.signature || null,
      orderingConfidence: dump.orderingConfidence || 'SLOT_CORRELATED',
      dump,
      allowSameSlotTrigger: true,
      entryReferenceTrade: dump.signalTrade,
      entryDataQualityConfig: this.dataQualityConfig,
      executionPlan: {
        ...this.executionConfig,
        ...this.config.executionOverrides,
        entryVariants: this.config.entryVariants,
        positionSizesSol: profile.positionSizesSol,
        exitProfiles: this.config.exitProfiles,
        combinationGrid: null,
        entryTimeoutMs: this.config.entryTimeoutMs,
        exitDelayMs: this.config.exitDelayMs,
        exitTimeoutMs: this.config.exitTimeoutMs,
        exitGraceMs: this.config.exitGraceMs,
        quoteModel: this.config.quoteModel,
        requireStrictlyAfterEntryReference: true,
        invalidatePendingEntryOnSecondDump: false,
        exitOnSecondDump: false,
      },
      snapshot: {
        slotDelta: 0,
        currentPrice: dump.postPrice,
        lowPrice: dump.lowPrice,
        priceBouncePct: 0,
        dropRecoveryPct: 0,
        validBuySol: 0,
        uniqueBuyers: 0,
        buyToDumpPct: 0,
        netFlowSol: 0,
        netFlow1sSol: null,
        netFlow3sSol: null,
        currentQuoteSol: dump.postQuoteSol,
        absorptionScore: null,
        absorptionScoreComponents: null,
        researchKind: 'DIRECT_DUMP_MANAGED_MATRIX_V1',
        sellSol: dump.sellSol,
        sellToQuotePct: dump.sellToQuotePct,
        dropPct: dump.dropPct,
        poolAgeMs: dump.poolAgeMs,
        poolAgeIgnored: true,
        signalProfileId: profile.id,
        toxicRejected: Boolean(toxic.rejected),
        toxicReasons: toxic.reasons || [],
        addOnPolicy: 'EACH_DUMP_IS_AN_INDEPENDENT_LOT',
      },
    };
  }

  health() {
    return {
      enabled: Boolean(this.config.enabled),
      mode: 'PUMPSWAP_DIRECT_DUMP_MATRIX_NO_SEND',
      sendsTransactions: false,
      signalProfiles: this.config.signalProfiles?.map((profile) => profile.id) || [],
      entryVariants: this.config.entryVariants?.map((entry) => entry.id) || [],
      exitProfiles: this.config.exitProfiles?.length || 0,
      ...this.metrics,
    };
  }
}

module.exports = { DumpBounceMatrix };
