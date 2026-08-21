'use strict';

class ToxicFlowFilter {
  constructor({ config, store = null }) {
    this.config = config;
    this.store = store;
    this.historical = new Map();
    for (const row of store?.listToxicWallets?.() || []) {
      this.historical.set(row.wallet, row);
    }
  }

  evaluateDump(dump) {
    const reasons = [];
    if (dump.seller && dump.coinCreator && dump.seller === dump.coinCreator) reasons.push('CREATOR_SELL');
    if (dump.seller && this.config.toxicWallets.has(dump.seller)) reasons.push('KNOWN_TOXIC_SELLER');
    if (dump.seller && this.historical.has(dump.seller)) reasons.push('HISTORICAL_RUG_SELLER');
    if (dump.seller && this.config.relatedWallets.has(dump.seller)) reasons.push('KNOWN_RELATED_SELLER');
    const pre = dump.preWindow || {};
    if (pre.trades >= this.config.minPreTrades
      && pre.buySharePct >= this.config.mechanicalMinBuySharePct
      && pre.priceRunupPct >= this.config.mechanicalMinRunupPct) {
      reasons.push('MECHANICAL_RUNUP');
    }
    if (pre.trades >= this.config.minPreTrades
      && pre.largestBuyerSharePct >= this.config.maxLargestBuyerSharePct) {
      reasons.push('BUYER_CONCENTRATION');
    }
    const hardReasons = reasons.filter((reason) => this.config.hardRejectReasons.has(reason)
      || reason === 'HISTORICAL_RUG_SELLER');
    return {
      rejected: hardReasons.length > 0,
      reasons,
      hardReasons,
      evaluatedAtMs: dump.detectedAtMs,
      causalOnly: true,
      unavailableChecks: ['TOP_HOLDER_RPC', 'WALLET_CLUSTER_RPC'],
    };
  }

  excludedRecoveryWallet(wallet, dump) {
    if (!wallet) return 'UNKNOWN_WALLET';
    if (wallet === dump.seller) return 'SELLER_WALLET';
    if (dump.coinCreator && wallet === dump.coinCreator) return 'CREATOR_WALLET';
    if (this.config.relatedWallets.has(wallet)) return 'KNOWN_RELATED_WALLET';
    if (this.config.toxicWallets.has(wallet) || this.historical.has(wallet)) return 'KNOWN_TOXIC_WALLET';
    return null;
  }

  recordToxicOutcome(wallet, reason, timestampMs, episodeId) {
    if (!wallet) return;
    const current = this.historical.get(wallet) || { wallet, incidents: 0 };
    const next = {
      wallet,
      incidents: current.incidents + 1,
      lastReason: reason,
      lastSeenAtMs: timestampMs,
      lastEpisodeId: episodeId,
    };
    this.historical.set(wallet, next);
    this.store?.upsertToxicWallet?.(next);
  }

  health() {
    return {
      configuredToxicWallets: this.config.toxicWallets.size,
      configuredRelatedWallets: this.config.relatedWallets.size,
      historicalToxicWallets: this.historical.size,
    };
  }
}

module.exports = { ToxicFlowFilter };
