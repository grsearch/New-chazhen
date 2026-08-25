'use strict';

const { reservePrice } = require('./AmmQuote');
const { strictlyAfter } = require('./SlotAssembler');
const { assessTradeDataQuality } = require('./TradeDataQuality');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class SameSlotProbe {
  constructor({
    retentionMs = 5_000, dataQualityConfig = null, maxPriceBouncePct = 500,
  } = {}) {
    this.retentionMs = retentionMs;
    this.dataQualityConfig = dataQualityConfig;
    this.maxPriceBouncePct = maxPriceBouncePct;
    this.episodes = new Map();
    this.byPool = new Map();
    this.metrics = {
      trackedDumps: 0,
      observations: 0,
      strictAfterDumpBuys: 0,
      slotCorrelatedBuys: 0,
    };
  }

  startEpisode(dump) {
    if (!dump?.episodeId || !dump.pool || dump.slot == null) return;
    this.episodes.set(dump.episodeId, dump);
    const ids = this.byPool.get(dump.pool) || new Set();
    ids.add(dump.episodeId);
    this.byPool.set(dump.pool, ids);
    this.metrics.trackedDumps += 1;
  }

  observeTrade(trade) {
    const ids = this.byPool.get(trade?.pool);
    if (!ids?.size) return [];
    const tradeSlot = finite(trade.slot);
    const observations = [];
    for (const episodeId of [...ids]) {
      const dump = this.episodes.get(episodeId);
      const dumpSlot = finite(dump?.slot);
      if (tradeSlot == null || dumpSlot == null || tradeSlot < dumpSlot) continue;
      if (tradeSlot > dumpSlot) {
        this._remove(episodeId, dump.pool);
        continue;
      }
      const signalDecimals = finite(dump.signalTrade?.tokenDecimals);
      const tradeDecimals = finite(trade.tokenDecimals);
      if (trade.mint !== dump.mint
        || (signalDecimals != null && tradeDecimals != null && signalDecimals !== tradeDecimals)) {
        continue;
      }
      if (trade.side !== 'BUY') continue;
      if (trade.signature === dump.signature && trade.eventIndex === dump.eventIndex) continue;

      const order = strictlyAfter(trade, dump.signalTrade);
      if (order === false) continue;
      const classification = order === true ? 'STRICT_AFTER_DUMP' : 'SLOT_CORRELATED';
      const at = finite(trade.receivedAtMs ?? trade.timestampMs, Date.now());
      const price = reservePrice(trade);
      const quality = assessTradeDataQuality(
        trade, this.dataQualityConfig, dump.signalTrade,
      );
      const priceBouncePct = dump.postPrice > 0 && price > 0
        ? (price / dump.postPrice - 1) * 100 : null;
      if (Number.isFinite(priceBouncePct)
        && Math.abs(priceBouncePct) > this.maxPriceBouncePct) {
        quality.status = 'QUARANTINED';
        quality.reasons = [...new Set([
          ...quality.reasons, 'OBSERVATION_PRICE_BOUNCE_ABOVE_LIMIT',
        ])];
      }
      const observation = {
        observationId: [
          episodeId,
          trade.signature || `receive-${trade.receiveSequence || at}`,
          trade.eventIndex ?? 0,
        ].join(':'),
        episodeId,
        mint: dump.mint,
        pool: dump.pool,
        observedAtMs: at,
        slot: tradeSlot,
        dumpTransactionIndex: finite(dump.transactionIndex),
        buyTransactionIndex: finite(trade.transactionIndex),
        instructionIndex: finite(trade.instructionIndex),
        eventIndex: finite(trade.eventIndex, 0),
        signature: trade.signature || null,
        wallet: trade.wallet || null,
        classification,
        receiveLagMs: Math.max(0, at - dump.detectedAtMs),
        buySol: Math.max(0, finite(trade.solAmount, 0)),
        price,
        priceBouncePct,
        dataQualityStatus: quality.status,
        dataQualityReasons: quality.reasons,
        executable: false,
        rejectionReason: order === true
          ? 'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE'
          : 'ORDER_UNCONFIRMED_NO_SAME_SLOT_GUARANTEE',
      };
      observations.push(observation);
      this.metrics.observations += 1;
      if (order === true) this.metrics.strictAfterDumpBuys += 1;
      else this.metrics.slotCorrelatedBuys += 1;
    }
    return observations;
  }

  advanceTime(now = Date.now()) {
    for (const [episodeId, dump] of this.episodes) {
      if (now - dump.detectedAtMs > this.retentionMs) this._remove(episodeId, dump.pool);
    }
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
      activeDumps: this.episodes.size,
      activePools: this.byPool.size,
      retentionMs: this.retentionMs,
      executionEnabled: false,
      ...this.metrics,
    };
  }
}

module.exports = { SameSlotProbe };
