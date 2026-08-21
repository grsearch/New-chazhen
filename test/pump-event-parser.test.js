'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bs58Module = require('bs58');
const { PumpEventParser, DISCRIMINATORS } = require('../src/core/PumpEventParser');

const bs58 = bs58Module.default || bs58Module;
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL = 'So11111111111111111111111111111111111111112';

const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const i64 = (value) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; };
const i128 = (value) => {
  const b = Buffer.alloc(16);
  const n = BigInt(value);
  b.writeBigUInt64LE(BigInt.asUintN(64, n), 0);
  b.writeBigInt64LE(BigInt.asIntN(64, n >> 64n), 8);
  return b;
};
const key = (byte) => Buffer.alloc(32, byte);
const string = (text) => {
  const data = Buffer.from(text);
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length);
  return Buffer.concat([size, data]);
};

function latestBuyEvent() {
  return Buffer.concat([
    DISCRIMINATORS.ammBuy,
    i64(1_800_000_000),
    u64(100_000_000), u64(2_000_000_000), u64(1), u64(2),
    u64(1_000_000_000_000), u64(100_000_000_000), u64(990_000_000),
    u64(20), u64(1_980_000), u64(5), u64(495_000),
    u64(991_980_000), u64(992_475_000),
    key(1), key(2),
    key(3), key(4), key(5), key(6), key(7),
    u64(50), u64(4_950_000),
    Buffer.from([1]), u64(10), u64(20), u64(30), i64(1_800_000_000),
    u64(99_000_000), string('buy'),
    u64(0), u64(0), u64(10), u64(990_000),
    i128(-1_000_000_000), Buffer.from([1]), u64(1_000_000_000_000),
  ]);
}

test('latest PumpSwap event preserves raw fees, decimals, and strict order coordinates', () => {
  const parser = new PumpEventParser({
    pumpProgramId: PUMP, pumpAmmProgramId: AMM, wsolMint: WSOL, defaultTokenDecimals: 6,
  });
  const data = latestBuyEvent().toString('base64');
  const events = parser.parseTransaction({
    slot: 123,
    index: 7,
    signature: 'signature-1',
    meta: {
      err: null,
      preTokenBalances: [{ mint: 'TokenMint', uiTokenAmount: { decimals: 8 } }],
      postTokenBalances: [],
      logMessages: [`Program ${AMM} invoke [1]`, `Program data: ${data}`, `Program ${AMM} success`],
    },
  }, 1_800_000_000_123);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.side, 'BUY');
  assert.equal(event.transactionIndex, 7);
  assert.equal(event.instructionIndex, 0);
  assert.equal(event.eventIndex, 0);
  assert.equal(event.orderingConfidence, 'STRICT');
  assert.equal(event.tokenDecimals, 8);
  assert.equal(event.tokenDecimalsSource, 'TOKEN_BALANCE');
  assert.equal(event.solAmount, 0.992475);
  assert.equal(event.coinCreator, bs58.encode(key(7)));
  assert.equal(event.coinCreatorFeeBasisPoints, 50);
  assert.equal(event.buybackFeeBasisPoints, 10);
  assert.equal(event.totalFeeBps, 85);
  assert.equal(event.effectiveQuoteReservesRaw, '99000000000');
  assert.equal(event.baseSupplyRaw, '1000000000000');
});

test('missing transaction index is explicitly not strict', () => {
  const parser = new PumpEventParser({
    pumpProgramId: PUMP, pumpAmmProgramId: AMM, wsolMint: WSOL, defaultTokenDecimals: 6,
  });
  const events = parser.parseTransaction({
    slot: 124,
    signature: 'signature-2',
    meta: {
      err: null,
      preTokenBalances: [{ mint: 'TokenMint', uiTokenAmount: { decimals: 6 } }],
      logMessages: [
        `Program ${AMM} invoke [1]`,
        `Program data: ${latestBuyEvent().toString('base64')}`,
        `Program ${AMM} success`,
      ],
    },
  });
  assert.equal(events[0].transactionIndex, null);
  assert.equal(events[0].orderingConfidence, 'SLOT_CORRELATED');
});
