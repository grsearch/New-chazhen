'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');

const POOL_BASE_MINT_OFFSET = 8 + 1 + 2 + 32;
const POOL_QUOTE_MINT_OFFSET = POOL_BASE_MINT_OFFSET + 32;
const MIN_POOL_ACCOUNT_BYTES = POOL_QUOTE_MINT_OFFSET + 32;
const MINT_DECIMALS_OFFSET = 44;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const DEFAULT_CACHE_MAX = 200_000;

class PumpPoolResolver {
  constructor({ config, connection = null } = {}) {
    this.config = config;
    this.connection = connection || new Connection(config.stream.rpcUrl, {
      commitment: 'processed',
      disableRetryOnRateLimit: false,
    });
    this.cache = new Map();
    this.pending = new Map();
    this.failures = new Map();
    this.retryAfterMs = Number(config.stream.poolResolveRetryMs) || DEFAULT_RETRY_AFTER_MS;
    this.cacheMax = Number(config.stream.poolCacheMax) || DEFAULT_CACHE_MAX;
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      negativeCacheHits: 0,
      rpcCalls: 0,
      resolved: 0,
      unsupportedQuoteMint: 0,
      errors: 0,
    };
  }

  async resolve(pool) {
    if (!pool) return null;
    if (this.cache.has(pool)) {
      this.metrics.cacheHits += 1;
      return this.cache.get(pool);
    }
    if (this.pending.has(pool)) return this.pending.get(pool);
    const retryAt = this.failures.get(pool);
    if (retryAt > Date.now()) {
      this.metrics.negativeCacheHits += 1;
      return null;
    }
    this.failures.delete(pool);
    this.metrics.cacheMisses += 1;
    const request = this._fetch(pool).finally(() => this.pending.delete(pool));
    this.pending.set(pool, request);
    return request;
  }

  async _accountInfo(pubkey) {
    this.metrics.rpcCalls += 1;
    return this.connection.getAccountInfo(new PublicKey(pubkey), 'processed');
  }

  async _fetch(pool) {
    try {
      const poolInfo = await this._accountInfo(pool);
      if (poolInfo?.owner
        && poolInfo.owner.toBase58() !== this.config.pump.ammProgramId) {
        throw new Error('Pool account is not owned by the PumpSwap program');
      }
      const data = poolInfo?.data ? Buffer.from(poolInfo.data) : null;
      if (!data || data.length < MIN_POOL_ACCOUNT_BYTES) {
        throw new Error('PumpSwap pool account is missing or shorter than the public IDL layout');
      }
      const mint = new PublicKey(
        data.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32),
      ).toBase58();
      const quoteMint = new PublicKey(
        data.subarray(POOL_QUOTE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET + 32),
      ).toBase58();
      if (quoteMint !== this.config.pump.wsolMint) {
        this.metrics.unsupportedQuoteMint += 1;
        this.cache.set(pool, null);
        return null;
      }
      const mintInfo = await this._accountInfo(mint);
      const mintData = mintInfo?.data ? Buffer.from(mintInfo.data) : null;
      if (!mintData || mintData.length <= MINT_DECIMALS_OFFSET) {
        throw new Error('PumpSwap base mint account is missing or malformed');
      }
      const decimals = mintData[MINT_DECIMALS_OFFSET];
      const result = {
        mint,
        quoteMint,
        tokenDecimals: Number.isInteger(decimals)
          ? decimals : this.config.pump.defaultTokenDecimals,
        tokenDecimalsSource: 'PUMPSWAP_POOL_AND_MINT_ACCOUNTS',
      };
      this.cache.set(pool, result);
      if (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value);
      this.metrics.resolved += 1;
      return result;
    } catch (error) {
      this.metrics.errors += 1;
      this.failures.set(pool, Date.now() + this.retryAfterMs);
      return null;
    }
  }

  health() {
    return {
      mode: 'ON_DEMAND_POOL_METADATA',
      cachedPools: this.cache.size,
      pendingPools: this.pending.size,
      retrySuppressedPools: this.failures.size,
      ...this.metrics,
    };
  }
}

module.exports = {
  PumpPoolResolver,
  POOL_BASE_MINT_OFFSET,
  POOL_QUOTE_MINT_OFFSET,
};
