'use strict';

function bigint(value) {
  try { return BigInt(value ?? 0); } catch (_) { return 0n; }
}

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pow10(decimals) {
  return 10 ** Math.max(0, Math.trunc(finite(decimals, 0)));
}

function effectiveReserves(trade = {}) {
  const baseRaw = bigint(trade.poolBaseReservesRaw);
  const quoteRaw = trade.effectiveQuoteReservesRaw != null
    ? bigint(trade.effectiveQuoteReservesRaw)
    : bigint(trade.poolQuoteReservesRaw) + bigint(trade.virtualQuoteReservesRaw);
  if (baseRaw <= 0n || quoteRaw <= 0n) return null;
  return {
    baseRaw,
    quoteRaw,
    tokenDecimals: Math.max(0, Math.trunc(finite(trade.tokenDecimals, 6))),
    source: 'PUMPSWAP_EFFECTIVE_RESERVES',
  };
}

function feeBps(trade = {}) {
  // PumpSwap's official SDK prices swaps with the LP, protocol, and coin-creator
  // fee components. buyback_fee_basis_points is a fee-allocation/share field;
  // it is preserved by the parser for research, but is not an additional fee on
  // the swap amount.
  const total = [
    trade.lpFeeBasisPoints,
    trade.protocolFeeBasisPoints,
    trade.coinCreatorFeeBasisPoints,
  ].reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
  return Math.min(9_000, total);
}

function protocolFeeBps(trade = {}) {
  return Math.max(0, finite(trade.protocolFeeBasisPoints, 0));
}

function reservePrice(trade = {}) {
  const reserves = effectiveReserves(trade);
  if (!reserves) return null;
  const base = Number(reserves.baseRaw) / pow10(reserves.tokenDecimals);
  const quote = Number(reserves.quoteRaw) / 1e9;
  return base > 0 && quote > 0 ? quote / base : null;
}

function quoteBuy(trade, spendSol, { slippageBps = 0 } = {}) {
  const reserves = effectiveReserves(trade);
  const spend = finite(spendSol);
  const marketPrice = reservePrice(trade);
  if (!reserves || !(spend > 0)) {
    return { available: false, reason: 'ENTRY_RESERVES_UNAVAILABLE', marketPrice };
  }
  const inputRaw = BigInt(Math.max(1, Math.round(spend * 1e9)));
  const protocolBps = feeBps(trade);
  const curveInputRaw = inputRaw * 10_000n / BigInt(Math.ceil(10_000 + protocolBps));
  let baseOutRaw = reserves.baseRaw * curveInputRaw / (reserves.quoteRaw + curveInputRaw);
  const slip = Math.min(9_000, Math.max(0, Math.round(finite(slippageBps, 0))));
  baseOutRaw = baseOutRaw * BigInt(10_000 - slip) / 10_000n;
  const tokenUnits = Number(baseOutRaw) / pow10(reserves.tokenDecimals);
  if (!(tokenUnits > 0)) {
    return { available: false, reason: 'ENTRY_ZERO_OUTPUT', marketPrice };
  }
  const price = spend / tokenUnits;
  return {
    available: true,
    reason: null,
    price,
    marketPrice,
    tokenUnits,
    baseOutRaw: baseOutRaw.toString(),
    curveInputRaw: curveInputRaw.toString(),
    userInputSol: spend,
    impactPct: marketPrice > 0 ? (price / marketPrice - 1) * 100 : null,
    liquidityUsagePct: Number(inputRaw) / Number(reserves.quoteRaw) * 100,
    protocolFeeBps: protocolFeeBps(trade),
    totalFeeBps: protocolBps,
    slippageBps: slip,
    reserveSource: reserves.source,
  };
}

function reservesAfterBuy(trade, buy) {
  const reserves = effectiveReserves(trade);
  if (!reserves || !buy?.available) return null;
  const baseOutRaw = bigint(buy.baseOutRaw);
  const curveInputRaw = bigint(buy.curveInputRaw);
  const baseRaw = reserves.baseRaw - baseOutRaw;
  const quoteRaw = reserves.quoteRaw + curveInputRaw;
  if (baseRaw <= 0n || quoteRaw <= 0n) return null;
  return {
    ...trade,
    poolBaseReservesRaw: baseRaw.toString(),
    effectiveQuoteReservesRaw: quoteRaw.toString(),
  };
}

function quoteImmediateRoundTrip(trade, spendSol, {
  buySlippageBps = 0,
  sellSlippageBps = 0,
} = {}) {
  const spend = finite(spendSol);
  const buy = quoteBuy(trade, spend, { slippageBps: buySlippageBps });
  if (!buy.available) return { available: false, reason: buy.reason, buy, sell: null };
  const afterBuy = reservesAfterBuy(trade, buy);
  if (!afterBuy) {
    return { available: false, reason: 'POST_BUY_RESERVES_UNAVAILABLE', buy, sell: null };
  }
  const sell = quoteSell(afterBuy, buy.tokenUnits, { slippageBps: sellSlippageBps });
  if (!sell.available) return { available: false, reason: sell.reason, buy, sell };
  const roundTripLossPct = spend > 0 ? Math.max(0, (1 - sell.proceedsSol / spend) * 100) : null;
  return {
    available: true,
    reason: null,
    buy,
    sell,
    afterBuy,
    proceedsSol: sell.proceedsSol,
    roundTripLossPct,
    entryLiquidityUsagePct: buy.liquidityUsagePct,
    exitLiquidityUsagePct: sell.liquidityUsagePct,
  };
}

function quoteSell(trade, tokenUnits, { slippageBps = 0 } = {}) {
  const reserves = effectiveReserves(trade);
  const units = finite(tokenUnits);
  const marketPrice = reservePrice(trade);
  if (!reserves || !(units > 0)) {
    return { available: false, reason: 'EXIT_RESERVES_UNAVAILABLE', marketPrice };
  }
  const inputRaw = BigInt(Math.max(1, Math.round(units * pow10(reserves.tokenDecimals))));
  const curveGrossRaw = reserves.quoteRaw * inputRaw / (reserves.baseRaw + inputRaw);
  const protocolBps = feeBps(trade);
  const slip = Math.min(9_000, Math.max(0, Math.round(finite(slippageBps, 0))));
  let userOutRaw = curveGrossRaw * BigInt(Math.max(0, 10_000 - Math.ceil(protocolBps))) / 10_000n;
  userOutRaw = userOutRaw * BigInt(10_000 - slip) / 10_000n;
  const proceedsSol = Number(userOutRaw) / 1e9;
  if (!(proceedsSol >= 0) || !Number.isFinite(proceedsSol)) {
    return { available: false, reason: 'EXIT_INVALID_OUTPUT', marketPrice };
  }
  const price = proceedsSol / units;
  return {
    available: true,
    reason: null,
    price,
    marketPrice,
    proceedsSol,
    quoteOutRaw: userOutRaw.toString(),
    impactPct: marketPrice > 0 ? (price / marketPrice - 1) * 100 : null,
    liquidityUsagePct: Number(inputRaw) / Number(reserves.baseRaw) * 100,
    protocolFeeBps: protocolFeeBps(trade),
    totalFeeBps: protocolBps,
    slippageBps: slip,
    reserveSource: reserves.source,
  };
}

function reconstructPreSell(trade = {}) {
  if (trade.side !== 'SELL') return null;
  const post = effectiveReserves(trade);
  if (!post) return null;
  const baseInRaw = bigint(trade.baseAmountRaw);
  // SellEvent.quote_amount_out is the pool-side amount after LP fee. Adding
  // it back is the most conservative event-only reconstruction available.
  const quoteOutRaw = bigint(trade.quoteAmountRaw);
  const baseBeforeRaw = post.baseRaw - baseInRaw;
  const quoteBeforeRaw = post.quoteRaw + quoteOutRaw;
  if (baseBeforeRaw <= 0n || quoteBeforeRaw <= 0n) return null;
  const baseBefore = Number(baseBeforeRaw) / pow10(post.tokenDecimals);
  const quoteBefore = Number(quoteBeforeRaw) / 1e9;
  return {
    baseBeforeRaw,
    quoteBeforeRaw,
    price: baseBefore > 0 ? quoteBefore / baseBefore : null,
    source: 'SELL_EVENT_POST_RESERVE_RECONSTRUCTION',
  };
}

function transactionFeeSol(config = {}) {
  return Math.max(0, finite(config.baseTxFeeSol, 0))
    + Math.max(0, finite(config.priorityFeeSol, 0))
    + Math.max(0, finite(config.jitoTipSol, 0));
}

module.exports = {
  effectiveReserves,
  feeBps,
  reservePrice,
  quoteBuy,
  quoteSell,
  quoteImmediateRoundTrip,
  reservesAfterBuy,
  reconstructPreSell,
  transactionFeeSol,
};
