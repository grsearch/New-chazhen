'use strict';

const { effectiveReserves, reservePrice } = require('./AmmQuote');
const { strictlyAfter } = require('./SlotAssembler');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pct(part, whole) {
  return whole > 0 ? part / whole * 100 : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, finite(value, min)));
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

class RecoveryConfirmer {
  constructor({ config, toxicFilter, now = () => Date.now() }) {
    this.config = config;
    this.toxicFilter = toxicFilter;
    this.now = now;
    this.episodes = new Map();
    this.byPool = new Map();
  }

  startEpisode(dump, toxicDecision) {
    const state = {
      dump,
      toxicDecision,
      eligible: !toxicDecision.rejected,
      status: toxicDecision.rejected ? 'TOXIC_REJECTED' : 'OBSERVING',
      lowPrice: dump.postPrice,
      currentPrice: dump.postPrice,
      currentQuoteSol: dump.postQuoteSol,
      lastPrice: dump.postPrice,
      validBuySol: 0,
      rawBuySol: 0,
      followSellSol: 0,
      uniqueBuyers: new Set(),
      invalidBuyReasons: new Map(),
      lastNewBuyerAtMs: null,
      sameSlotStrictBuySol: 0,
      sameSlotCorrelatedBuySol: 0,
      strictSameSlotBuys: 0,
      correlatedSameSlotBuys: 0,
      flowEvents: [],
      secondDump: false,
      secondDumpAtMs: null,
      confirmedProfiles: new Set(),
      horizonSurvival: {},
      maxRecoveryPct: 0,
      lastSnapshot: null,
      toxicOutcomeRecorded: false,
    };
    this.episodes.set(dump.episodeId, state);
    const ids = this.byPool.get(dump.pool) || new Set();
    ids.add(dump.episodeId);
    this.byPool.set(dump.pool, ids);
    return this._snapshot(state, dump.signalTrade);
  }

  observeTrade(trade) {
    const ids = this.byPool.get(trade?.pool);
    if (!ids?.size) return { updates: [], confirmations: [], toxicOutcomes: [] };
    const updates = [];
    const confirmations = [];
    const toxicOutcomes = [];
    for (const episodeId of [...ids]) {
      const state = this.episodes.get(episodeId);
      if (!state || !this._afterSignal(trade, state.dump)) continue;
      const signalDecimals = finite(state.dump.signalTrade?.tokenDecimals);
      const tradeDecimals = finite(trade.tokenDecimals);
      if (trade.mint !== state.dump.mint
        || (signalDecimals != null && tradeDecimals != null && signalDecimals !== tradeDecimals)) {
        continue;
      }
      const at = finite(trade.receivedAtMs ?? trade.timestampMs, this.now());
      const currentPrice = reservePrice(trade);
      const reserves = effectiveReserves(trade);
      const currentQuoteSol = reserves ? Number(reserves.quoteRaw) / 1e9 : null;
      const slotDelta = this._slotDelta(trade.slot, state.dump.slot);
      const sameSlot = slotDelta === 0;
      const strictSameSlot = sameSlot ? strictlyAfter(trade, state.dump.signalTrade) : null;

      if (currentPrice > 0) {
        state.lowPrice = Math.min(state.lowPrice, currentPrice);
        state.currentPrice = currentPrice;
      }
      if (currentQuoteSol > 0) state.currentQuoteSol = currentQuoteSol;

      if (trade.side === 'BUY') {
        const amount = Math.max(0, finite(trade.solAmount, 0));
        state.rawBuySol += amount;
        if (sameSlot) {
          if (strictSameSlot === true) {
            state.sameSlotStrictBuySol += amount;
            state.strictSameSlotBuys += 1;
          } else {
            state.sameSlotCorrelatedBuySol += amount;
            state.correlatedSameSlotBuys += 1;
          }
        }
        const exclusion = this.toxicFilter.excludedRecoveryWallet(trade.wallet, state.dump);
        const tooSmall = amount < this.config.minValidBuySol;
        if (exclusion || tooSmall || sameSlot) {
          const reason = sameSlot ? (strictSameSlot === true ? 'SAME_SLOT_STRICT_STATS_ONLY' : 'SAME_SLOT_CORRELATED')
            : (exclusion || 'DUST_BUY');
          state.invalidBuyReasons.set(reason, (state.invalidBuyReasons.get(reason) || 0) + 1);
        } else {
          state.validBuySol += amount;
          if (trade.wallet && !state.uniqueBuyers.has(trade.wallet)) {
            state.uniqueBuyers.add(trade.wallet);
            state.lastNewBuyerAtMs = at;
          }
          state.flowEvents.push({ at, amount });
        }
      } else if (trade.side === 'SELL') {
        const amount = Math.max(0, finite(trade.solAmount, 0));
        state.followSellSol += amount;
        if (!sameSlot) state.flowEvents.push({ at, amount: -amount });
        const priceStepDropPct = state.lastPrice > 0 && currentPrice > 0
          ? (1 - currentPrice / state.lastPrice) * 100 : 0;
        const threshold = Math.max(
          this.config.secondDumpMinSol,
          state.dump.sellSol * this.config.secondDumpFractionOfInitial,
        );
        if (!sameSlot && !state.secondDump
          && (amount >= threshold || priceStepDropPct >= this.config.secondDumpMinPriceDropPct)) {
          state.secondDump = true;
          state.secondDumpAtMs = at;
          state.status = 'SECOND_DUMP';
          if (!state.toxicOutcomeRecorded) {
            toxicOutcomes.push({
              wallet: state.dump.seller,
              reason: 'POST_DUMP_SECOND_LARGE_SELL',
              timestampMs: at,
              episodeId,
            });
            state.toxicOutcomeRecorded = true;
          }
        }
      }
      if (currentPrice > 0) state.lastPrice = currentPrice;
      state.flowEvents = state.flowEvents.filter((row) => row.at >= at - 3_000);
      this._markSurvival(state, at);
      const snapshot = this._snapshot(state, trade);
      state.lastSnapshot = snapshot;
      updates.push(snapshot);

      if (!state.secondDump) {
        for (const profile of this.config.profiles) {
          const profileEligible = state.eligible
            || (profile.researchOnly && profile.allowToxicResearch);
          if (!profileEligible) continue;
          if (state.confirmedProfiles.has(profile.id) || !this._profileMet(profile, snapshot)) continue;
          state.confirmedProfiles.add(profile.id);
          state.status = state.toxicDecision.rejected
            ? 'TOXIC_RESEARCH_CONFIRMED' : 'CONFIRMED';
          confirmations.push({
            confirmationId: `${episodeId}:${profile.id}`,
            episodeId,
            profileId: profile.id,
            confirmedAtMs: at,
            slot: trade.slot ?? null,
            transactionIndex: trade.transactionIndex ?? null,
            instructionIndex: trade.instructionIndex ?? null,
            eventIndex: trade.eventIndex ?? null,
            signature: trade.signature || null,
            orderingConfidence: trade.orderingConfidence || 'SLOT_CORRELATED',
            researchOnly: Boolean(profile.researchOnly),
            dump: state.dump,
            snapshot,
          });
        }
      }
    }
    return { updates, confirmations, toxicOutcomes };
  }

  advanceTime(now = this.now()) {
    const expired = [];
    for (const [episodeId, state] of this.episodes) {
      if (now - state.dump.detectedAtMs <= this.config.maxObservationMs) continue;
      if (!['SECOND_DUMP', 'TOXIC_REJECTED'].includes(state.status)
        && !state.confirmedProfiles.size) state.status = 'EXPIRED_NO_CONFIRMATION';
      expired.push({ ...this._snapshot(state, null), terminal: true, status: state.status });
      this._remove(episodeId, state.dump.pool);
    }
    return expired;
  }

  isObservingPool(pool) {
    return Boolean(pool && this.byPool.has(pool));
  }

  _profileMet(profile, snapshot) {
    const minSlotDelta = finite(profile.minSlotDelta, 1);
    if (!(snapshot.slotDelta >= minSlotDelta)
      || snapshot.slotDelta > finite(profile.maxSlotDelta, Infinity)) return false;
    if (finite(snapshot.priceBouncePct, -Infinity)
      < finite(profile.minPriceBouncePct, 0)) return false;
    if (finite(snapshot.dropRecoveryPct, -Infinity)
      < finite(profile.minDropRecoveryPct, 0)) return false;
    if (snapshot.uniqueBuyers < finite(profile.minUniqueBuyers, 0)) return false;
    if (snapshot.validBuySol < finite(profile.minBuySol, 0)) return false;
    if (finite(snapshot.buyToDumpPct, 0) < finite(profile.minBuyToDumpPct, 0)) return false;
    if (finite(snapshot.absorptionScore, 0) < finite(profile.minAbsorptionScore, 0)) return false;
    if (profile.requirePositiveNetFlow && !(snapshot.netFlowSol > 0)) return false;
    if (profile.minPoolAgeMs && snapshot.poolAgeMs < profile.minPoolAgeMs) return false;
    if (profile.minPostQuoteSol && snapshot.postQuoteSol < profile.minPostQuoteSol) return false;
    if (snapshot.currentQuoteSol < snapshot.postQuoteSol * 0.9) return false;
    if (profile.requirePositiveFlow1sAnd3s
      && !(snapshot.netFlow1sSol > 0 && snapshot.netFlow3sSol > 0)) return false;
    return true;
  }

  _snapshot(state, trade) {
    const at = finite(trade?.receivedAtMs ?? trade?.timestampMs, this.now());
    const rawPriceBouncePct = state.lowPrice > 0
      ? (state.currentPrice / state.lowPrice - 1) * 100 : null;
    const dropRange = state.dump.prePrice - state.lowPrice;
    const rawDropRecoveryPct = dropRange > 0
      ? (state.currentPrice - state.lowPrice) / dropRange * 100 : null;
    const maxReported = finite(this.config.maxReportedRecoveryPct, 500);
    const priceBouncePct = rawPriceBouncePct != null && rawPriceBouncePct <= maxReported
      ? rawPriceBouncePct : null;
    const dropRecoveryPct = rawDropRecoveryPct != null && rawDropRecoveryPct <= maxReported
      ? rawDropRecoveryPct : null;
    if (dropRecoveryPct != null) {
      state.maxRecoveryPct = Math.max(state.maxRecoveryPct, finite(dropRecoveryPct, 0));
    }
    const netFlowAt = (windowMs) => state.flowEvents
      .filter((row) => row.at >= at - windowMs)
      .reduce((sum, row) => sum + row.amount, 0);
    const quoteRetentionPct = pct(state.currentQuoteSol, state.dump.postQuoteSol);
    const buyToDumpPct = pct(state.validBuySol, state.dump.sellSol);
    const netFlowSol = state.validBuySol - state.followSellSol;
    const scoreComponents = {
      capitalAbsorption: 30 * clamp(finite(buyToDumpPct, 0) / 20),
      priceResponse: 20 * clamp(finite(priceBouncePct, 0) / 6),
      buyerDiversity: 15 * clamp(state.uniqueBuyers.size / 3),
      quoteRetention: 15 * clamp((finite(quoteRetentionPct, 0) - 80) / 20),
      positiveNetFlow: 10 * clamp(state.validBuySol > 0 ? netFlowSol / state.validBuySol : 0),
      noSecondDump: state.secondDump ? 0 : 10,
      toxicPenalty: state.toxicDecision.rejected ? -35 : 0,
      followSellPenalty: -15 * clamp(
        finite(state.followSellSol, 0) / Math.max(finite(state.dump.sellSol, 0), 0.000001),
      ),
    };
    for (const [key, component] of Object.entries(scoreComponents)) {
      scoreComponents[key] = rounded(component);
    }
    const absorptionScore = rounded(clamp(
      Object.values(scoreComponents).reduce((sum, component) => sum + component, 0),
      0, 100,
    ));
    return {
      episodeId: state.dump.episodeId,
      status: state.status,
      observedAtMs: at,
      slot: trade?.slot ?? null,
      slotDelta: this._slotDelta(trade?.slot, state.dump.slot),
      currentPrice: state.currentPrice,
      lowPrice: state.lowPrice,
      priceBouncePct,
      dropRecoveryPct,
      maxRecoveryPct: state.maxRecoveryPct,
      postQuoteSol: state.dump.postQuoteSol,
      currentQuoteSol: state.currentQuoteSol,
      quoteRetentionPct,
      poolAgeMs: state.dump.poolAgeMs + Math.max(0, at - state.dump.detectedAtMs),
      rawBuySol: state.rawBuySol,
      validBuySol: state.validBuySol,
      followSellSol: state.followSellSol,
      netFlowSol,
      netFlow1sSol: netFlowAt(1_000),
      netFlow3sSol: netFlowAt(3_000),
      uniqueBuyers: state.uniqueBuyers.size,
      buyToDumpPct,
      absorptionScore,
      absorptionScoreComponents: scoreComponents,
      toxicAtSignal: Boolean(state.toxicDecision.rejected),
      lastNewBuyerAtMs: state.lastNewBuyerAtMs,
      buyerStalled: state.lastNewBuyerAtMs != null
        && at - state.lastNewBuyerAtMs >= this.config.buyerStallMs,
      sameSlotStrictBuySol: state.sameSlotStrictBuySol,
      sameSlotCorrelatedBuySol: state.sameSlotCorrelatedBuySol,
      strictSameSlotBuys: state.strictSameSlotBuys,
      correlatedSameSlotBuys: state.correlatedSameSlotBuys,
      invalidBuyReasons: Object.fromEntries(state.invalidBuyReasons),
      secondDump: state.secondDump,
      secondDumpAtMs: state.secondDumpAtMs,
      confirmedProfiles: [...state.confirmedProfiles],
      survival1s: state.horizonSurvival[1_000] ?? null,
      survival2s: state.horizonSurvival[2_000] ?? null,
      survival5s: state.horizonSurvival[5_000] ?? null,
      survival10s: state.horizonSurvival[10_000] ?? null,
    };
  }

  _markSurvival(state, at) {
    for (const horizon of [1_000, 2_000, 5_000, 10_000]) {
      if (state.horizonSurvival[horizon] != null || at < state.dump.detectedAtMs + horizon) continue;
      state.horizonSurvival[horizon] = state.currentPrice > 0
        && state.currentQuoteSol >= state.dump.postQuoteSol * 0.5 ? 1 : 0;
    }
  }

  _afterSignal(trade, dump) {
    if (trade.signature === dump.signature && trade.eventIndex === dump.eventIndex) return false;
    const tradeSlot = finite(trade.slot);
    const dumpSlot = finite(dump.slot);
    if (tradeSlot != null && dumpSlot != null) {
      if (tradeSlot > dumpSlot) return true;
      if (tradeSlot < dumpSlot) return false;
      const strict = strictlyAfter(trade, dump.signalTrade);
      return strict !== false;
    }
    return finite(trade.receiveSequence, Infinity) > finite(dump.signalTrade?.receiveSequence, -Infinity);
  }

  _slotDelta(slot, dumpSlot) {
    const current = finite(slot);
    const origin = finite(dumpSlot);
    return current == null || origin == null ? null : current - origin;
  }

  _remove(episodeId, pool) {
    this.episodes.delete(episodeId);
    const ids = this.byPool.get(pool);
    if (!ids) return;
    ids.delete(episodeId);
    if (!ids.size) this.byPool.delete(pool);
  }

  health() {
    return {
      activeEpisodes: this.episodes.size,
      observingPools: this.byPool.size,
      confirmedProfiles: [...this.episodes.values()]
        .reduce((sum, state) => sum + state.confirmedProfiles.size, 0),
    };
  }
}

module.exports = { RecoveryConfirmer };
