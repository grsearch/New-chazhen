'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const {
  PumpPoolResolver, POOL_BASE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET,
} = require('../src/core/PumpPoolResolver');

const WSOL = 'So11111111111111111111111111111111111111112';

test('lightweight pool resolver obtains mint and decimals once per PumpSwap pool', async () => {
  const pool = new PublicKey(Buffer.alloc(32, 9)).toBase58();
  const mint = new PublicKey(Buffer.alloc(32, 8)).toBase58();
  const poolData = Buffer.alloc(220);
  new PublicKey(mint).toBuffer().copy(poolData, POOL_BASE_MINT_OFFSET);
  new PublicKey(WSOL).toBuffer().copy(poolData, POOL_QUOTE_MINT_OFFSET);
  const mintData = Buffer.alloc(82);
  mintData[44] = 9;
  const calls = [];
  const connection = {
    getAccountInfo: async (pubkey) => {
      const key = pubkey.toBase58();
      calls.push(key);
      return { data: key === pool ? poolData : mintData };
    },
  };
  const resolver = new PumpPoolResolver({
    config: {
      pump: { wsolMint: WSOL, defaultTokenDecimals: 6 },
      stream: { rpcUrl: 'https://unused.invalid' },
    },
    connection,
  });

  assert.deepEqual(await resolver.resolve(pool), {
    mint,
    quoteMint: WSOL,
    tokenDecimals: 9,
    tokenDecimalsSource: 'PUMPSWAP_POOL_AND_MINT_ACCOUNTS',
  });
  assert.equal((await resolver.resolve(pool)).mint, mint);
  assert.deepEqual(calls, [pool, mint]);
  assert.equal(resolver.health().cacheHits, 1);
  assert.equal(resolver.health().rpcCalls, 2);
});
