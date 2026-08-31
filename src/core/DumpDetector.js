'use strict';

const { effectiveReserves, reconstructPreSell, reservePrice } = require('./AmmQuote');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percent(part, whole) {
  return whole > 0 ? part / whole * 100 : null;
}

function comparablePoolTrade(left, right) {
  if (!left || !right) return false;
  if (left.pool !== right.pool || left.mint !== right.mint) return false;
  const leftDecimals = finite(left.tokenDecimals);
  const rightDecimals = finite(right.tokenDecimals);
  return leftDecimals == null || rightDecimals == null || leftDecimals === rightDecimals;
}

function preWindowStats(rows) {
  const buys = rows.filter((row) => row.side === 'BUY');
  const sells = rows.filter((row) => row.side === 'SELL');
  const buySol = buys.reduce((sum, row) => sum + finite(row.solAmount, 0), 0);
  const sellSol = sells.reduce((sum, row) => sum + finite(row.solAmount, 0), 0);
  const buyerSol = new Map();
  for (const row of buys) {
    const wallet = String(row.wallet || 'UNKNOWN');
    buyerSol.set(wallet, (buyerSol.get(wallet) || 0) + finite(row.solAmount, 0));
  }
  const largestBuyerSol = buyerSol.size ? Math.max(...buyerSol.values()) : 0;
  const prices = rows.map((row) => reservePrice(row)).filter((value) => value > 0);
  return {
    trades: rows.length,
    buys: buys.length,
    sells: sells.length,
    buySol,
    sellSol,
    netFlowSol: buySol - sellSol,
    buySharePct: percent(buys.length, rows.length),
    uniqueBuyers: buyerSol.size,
    largestBuyerSharePct: percent(largestBuyerSol, buySol),
    priceRunupPct: prices.length >= 2 ? (prices.at(-1) / prices[0] - 1) * 100 : null,
  };
}

class DumpDetector {
  constructor({ config, now = () => Date.now() }) {
    this.config = config;
    this.now = now;
    this.pools = new Map();
    this.migrations = new Map();
    this.lastDumpAt = new Map();
    this.metrics = { incompatibleTradesIgnored: 0, overMaxDropIgnored: 0 };
  }

  observeMigration(event) {
    if (!event?.pool) return;
    this.migrations.set(event.pool, finite(event.migratedAt ?? event.chainTimestampMs, this.now()));
  }

  observeTrade(trade) {
    if (trade?.market !== 'PUMP_AMM' || !trade.pool || !trade.mint) return null;
    const at = finite(trade.receivedAtMs ?? trade.timestampMs, this.now());
    const state = this.pools.get(trade.pool) || {
      pool: trade.pool,
      mint: trade.mint,
      tokenDecimals: trade.tokenDecimals,
      firstSeenAt: at,
      lastAt: at,
      rows: [],
    };
    if (state.mint !== trade.mint
      || (state.tokenDecimals != null && trade.tokenDecimals != null
        && Number(state.tokenDecimals) !== Number(trade.tokenDecimals))) {
      this.metrics.incompatibleTradesIgnored += 1;
      return null;
    }
    // Only the causal price/pre-dump window needs individual trades in memory.
    // Pool age and inactivity are tracked separately on the lightweight state object.
    const rowRetentionMs = Math.max(this.config.preWindowMs, this.config.priceFreshMs);
    const cutoff = at - rowRetentionMs;
    state.rows = state.rows.filter((row) => finite(row.receivedAtMs, 0) >= cutoff);
    const preRows = state.rows.filter((row) => finite(row.receivedAtMs, 0) >= at - this.config.preWindowMs);
    const previous = state.rows.at(-1);
    const postPrice = reservePrice(trade);
    const reconstructed = reconstructPreSell(trade);
    const previousPrice = comparablePoolTrade(previous, trade)
      && at - finite(previous.receivedAtMs, 0) <= this.config.priceFreshMs
      ? reservePrice(previous) : null;
    const prePrice = previousPrice > 0 ? previousPrice : reconstructed?.price;
    const prePriceSource = previousPrice > 0 ? 'PREVIOUS_PUBLIC_TRADE' : reconstructed?.source;
    const postReserves = effectiveReserves(trade);

    let dump = null;
    if (trade.side === 'SELL' && prePrice > 0 && postPrice > 0 && postPrice < prePrice && postReserves) {
      const postQuoteSol = Number(postReserves.quoteRaw) / 1e9;
      const preQuoteSol = reconstructed ? Number(reconstructed.quoteBeforeRaw) / 1e9 : null;
      const preBaseTokens = reconstructed
        ? Number(reconstructed.baseBeforeRaw) / (10 ** finite(trade.tokenDecimals, 6)) : null;
      const sellSol = finite(trade.solAmount, 0);
      const sellTokens = finite(trade.tokenAmount, 0);
      const dropPct = (1 - postPrice / prePrice) * 100;
      const sellToQuotePct = percent(sellSol, preQuoteSol);
      const sellTokenToReservePct = percent(sellTokens, preBaseTokens);
      const maxDropPct = finite(this.config.maxDropPct, Infinity);
      if (dropPct > maxDropPct) this.metrics.overMaxDropIgnored += 1;
      const migrationAt = this.migrations.get(trade.pool);
      const poolAgeMs = Math.max(0, at - (migrationAt || state.firstSeenAt));
      const poolAgeSource = migrationAt ? 'MIGRATION_EVENT' : 'OBSERVED_LOWER_BOUND';
      const profiles = this.config.profiles.filter((profile) => (
        sellToQuotePct != null
        && sellSol >= finite(profile.minSellSol, 0)
        && sellSol < finite(profile.maxSellSol, Infinity)
        && sellToQuotePct >= profile.minSellToQuotePct
        && dropPct >= profile.minDropPct
        && dropPct < finite(profile.maxDropPct, Infinity)
        && dropPct <= maxDropPct
        && postQuoteSol >= profile.minPostQuoteSol
        && poolAgeMs >= profile.minPoolAgeMs
      ));
      const cooldownPassed = at - (this.lastDumpAt.get(trade.pool) || 0) >= this.config.episodeCooldownMs;
      if (profiles.length && cooldownPassed) {
        this.lastDumpAt.set(trade.pool, at);
        dump = {
          episodeId: `${trade.mint}:${trade.signature || at}:${trade.eventIndex ?? 0}`,
          mint: trade.mint,
          pool: trade.pool,
          coinCreator: trade.coinCreator || null,
          seller: trade.wallet || null,
          detectedAtMs: at,
          chainTimestampMs: trade.chainTimestampMs ?? null,
          slot: trade.slot ?? null,
          transactionIndex: trade.transactionIndex ?? null,
          instructionIndex: trade.instructionIndex ?? null,
          eventIndex: trade.eventIndex ?? null,
          signature: trade.signature || null,
          orderingConfidence: trade.orderingConfidence || 'SLOT_CORRELATED',
          ingestionMode: trade.ingestionMode || 'UNKNOWN',
          parseVersion: trade.parseVersion || null,
          matchedDumpProfiles: profiles.map((profile) => profile.id),
          sellSol,
          sellTokens,
          prePrice,
          prePriceSource,
          postPrice,
          lowPrice: postPrice,
          dropPct,
          preQuoteSol,
          postQuoteSol,
          sellToQuotePct,
          sellTokenToReservePct,
          poolAgeMs,
          poolAgeSource,
          preWindow: preWindowStats(preRows),
          signalTrade: trade,
        };
      }
    }

    state.rows.push(trade);
    state.lastAt = at;
    state.mint = trade.mint;
    state.tokenDecimals = trade.tokenDecimals;
    this.pools.set(trade.pool, state);
    this._sweep(at);
    return dump;
  }

  recentTrades(pool, sinceMs = -Infinity) {
    const rows = this.pools.get(pool)?.rows || [];
    return rows.filter((row) => finite(row.receivedAtMs ?? row.timestampMs, 0) >= sinceMs);
  }

  _sweep(now) {
    const cutoff = now - this.config.stateRetentionMs;
    for (const [pool, state] of this.pools) if (state.lastAt < cutoff) this.pools.delete(pool);
  }

  health() {
    return {
      trackedPools: this.pools.size,
      knownMigrations: this.migrations.size,
      ...this.metrics,
    };
  }
}

module.exports = { DumpDetector, preWindowStats };
