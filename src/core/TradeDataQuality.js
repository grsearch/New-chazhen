'use strict';

const { effectiveReserves, reservePrice } = require('./AmmQuote');

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function pct(part, whole) {
  return whole > 0 ? part / whole * 100 : null;
}

function assessTradeDataQuality(trade, config, referenceTrade = null) {
  if (!config) return { status: 'UNASSESSED', reasons: [] };
  const reasons = [];
  const reserves = effectiveReserves(trade);
  const quoteSol = reserves ? Number(reserves.quoteRaw) / 1e9 : null;
  const tradeSol = Math.max(0, finite(trade?.solAmount, 0));
  const eventPrice = finite(trade?.price);
  const currentReservePrice = reservePrice(trade);
  if (tradeSol > config.maxTradeSol) reasons.push('TRADE_SOL_ABOVE_LIMIT');
  if (quoteSol != null && quoteSol > config.maxQuoteReserveSol) {
    reasons.push('QUOTE_RESERVE_ABOVE_LIMIT');
  }
  if (quoteSol > 0 && pct(tradeSol, quoteSol) > config.maxTradeToQuotePct) {
    reasons.push('TRADE_TO_QUOTE_ABOVE_LIMIT');
  }
  if (eventPrice > 0 && currentReservePrice > 0
    && Math.abs(eventPrice / currentReservePrice - 1) * 100
      > config.maxEventReservePriceDeviationPct) {
    reasons.push('EVENT_RESERVE_PRICE_DIVERGENCE');
  }
  const referenceReserves = referenceTrade ? effectiveReserves(referenceTrade) : null;
  const referenceQuoteSol = referenceReserves ? Number(referenceReserves.quoteRaw) / 1e9 : null;
  if (quoteSol > 0 && referenceQuoteSol > 0
    && Math.max(quoteSol, referenceQuoteSol) / Math.min(quoteSol, referenceQuoteSol)
      > config.maxQuoteReserveChangeMultiple) {
    reasons.push('QUOTE_RESERVE_DISCONTINUITY');
  }
  return {
    status: reasons.length ? 'QUARANTINED' : 'TRUSTED',
    reasons: [...new Set(reasons)],
  };
}

module.exports = { assessTradeDataQuality };
