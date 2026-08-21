'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  effectiveReserves, quoteBuy, quoteSell, reconstructPreSell,
} = require('../src/core/AmmQuote');

function market(overrides = {}) {
  return {
    side: 'SELL',
    tokenDecimals: 6,
    poolBaseReservesRaw: '1000000000000',
    poolQuoteReservesRaw: '100000000000',
    virtualQuoteReservesRaw: '-1000000000',
    baseAmountRaw: '1000000000',
    quoteAmountRaw: '100000000',
    lpFeeBasisPoints: 20,
    protocolFeeBasisPoints: 5,
    coinCreatorFeeBasisPoints: 50,
    buybackFeeBasisPoints: 5_000,
    ...overrides,
  };
}

test('effective reserves include signed virtual quote reserves', () => {
  const reserves = effectiveReserves(market());
  assert.equal(reserves.quoteRaw, 99_000_000_000n);
});

test('capacity quotes include event fees, price impact, and configured slippage', () => {
  const trade = market({ side: 'BUY' });
  const buy = quoteBuy(trade, 0.1, { slippageBps: 100 });
  assert.equal(buy.available, true);
  assert.equal(buy.protocolFeeBps, 5);
  assert.equal(buy.totalFeeBps, 75);
  assert.ok(buy.impactPct > 0);
  const sell = quoteSell(trade, buy.tokenUnits, { slippageBps: 100 });
  assert.equal(sell.available, true);
  assert.ok(sell.proceedsSol < 0.1, 'round trip must lose fees and slippage in a flat pool');
  assert.ok(sell.proceedsSol > 0.09, 'a 50% buyback allocation must not become a 50% swap fee');
});

test('pre-sell reconstruction uses post reserves plus the pool-side quote out', () => {
  const before = reconstructPreSell(market());
  assert.equal(before.baseBeforeRaw, 999_000_000_000n);
  assert.equal(before.quoteBeforeRaw, 99_100_000_000n);
  assert.ok(before.price > 0);
});
