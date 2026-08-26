'use strict';

const bs58Module = require('bs58');

const bs58 = bs58Module.default || bs58Module;

const DISCRIMINATORS = Object.freeze({
  pumpMigration: Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]),
  ammBuy: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  ammSell: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
});
const PUMP_PARSE_VERSION = 'PUMP_PUBLIC_IDL_2026_08_TOKEN_CONTEXT_V3';

function encodeBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value?.pubkey != null) return encodeBase58(value.pubkey);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return bs58.encode(Buffer.from(value));
  return null;
}

class BorshReader {
  constructor(buffer, offset = 0) {
    this.buffer = Buffer.from(buffer);
    this.offset = offset;
  }

  require(size) {
    if (this.offset + size > this.buffer.length) {
      throw new RangeError(`borsh buffer ended at ${this.offset}; need ${size} bytes`);
    }
  }

  u8() { this.require(1); return this.buffer[this.offset++]; }
  bool() { return this.u8() !== 0; }
  u32() { this.require(4); const value = this.buffer.readUInt32LE(this.offset); this.offset += 4; return value; }
  u64() { this.require(8); const value = this.buffer.readBigUInt64LE(this.offset); this.offset += 8; return value; }
  i64() { this.require(8); const value = this.buffer.readBigInt64LE(this.offset); this.offset += 8; return value; }
  i128() {
    this.require(16);
    const low = this.buffer.readBigUInt64LE(this.offset);
    const high = this.buffer.readBigInt64LE(this.offset + 8);
    this.offset += 16;
    return (high << 64n) + low;
  }
  pubkey() {
    this.require(32);
    const value = bs58.encode(this.buffer.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }
  string() {
    const length = this.u32();
    if (length > 1_048_576) throw new RangeError(`borsh string is too large: ${length}`);
    this.require(length);
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  remaining() { return this.buffer.length - this.offset; }
}

function numeric(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function rawToUnits(value, decimals) {
  const result = numeric(value);
  return result == null ? null : result / (10 ** decimals);
}

function timestampMs(seconds) {
  const value = numeric(seconds);
  return value == null ? null : value * 1_000;
}

function matches(buffer, discriminator) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(discriminator);
}

function extractMeta(message) {
  return message?.transaction?.meta
    || message?.meta
    || message?.transaction?.transaction?.meta
    || null;
}

function extractSlot(message) {
  const value = message?.slot ?? message?.transaction?.slot;
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isInteger(result) && result >= 0 ? result : null;
}

function extractTransactionIndex(message) {
  const candidates = [
    message?.index,
    message?.transactionIndex,
    message?.transaction_index,
    message?.transaction?.index,
    message?.transaction?.transactionIndex,
    message?.transaction?.transaction_index,
  ];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const result = Number(value);
    if (Number.isInteger(result) && result >= 0) return result;
  }
  return null;
}

function extractSignature(message) {
  const candidates = [
    message?.transaction?.signature,
    message?.signature,
    message?.transaction?.transaction?.signature,
    message?.transaction?.signatures?.[0],
    message?.transaction?.transaction?.signatures?.[0],
  ];
  for (const candidate of candidates) {
    const value = encodeBase58(candidate);
    if (value) return value;
  }
  return null;
}

function extractAccountKeys(message, meta) {
  const transaction = message?.transaction?.transaction || message?.transaction || message;
  const compiled = transaction?.message || transaction?.transaction?.message || {};
  const staticKeys = compiled.accountKeys || compiled.account_keys
    || compiled.staticAccountKeys || compiled.static_account_keys || [];
  const loaded = meta?.loadedAddresses || meta?.loaded_addresses || {};
  return [
    ...staticKeys,
    ...(loaded.writable || loaded.writableAddresses || loaded.writable_addresses || []),
    ...(loaded.readonly || loaded.readonlyAddresses || loaded.readonly_addresses || []),
  ].map(encodeBase58);
}

function extractTokenContexts(message, meta, wsolMint, fallbackDecimals) {
  const accountKeys = extractAccountKeys(message, meta);
  const candidates = new Map();
  const collect = (balances, side) => {
    for (const balance of balances || []) {
      if (!balance?.mint || balance.mint === wsolMint) continue;
      const row = candidates.get(balance.mint) || {
        mint: balance.mint, pre: 0n, post: 0n, decimals: null, accounts: new Set(),
      };
      const rawDecimals = balance?.uiTokenAmount?.decimals
        ?? balance?.ui_token_amount?.decimals ?? balance?.decimals;
      const decimals = rawDecimals == null ? null : Number(rawDecimals);
      if (Number.isInteger(decimals) && decimals >= 0) row.decimals = decimals;
      const amount = balance?.uiTokenAmount?.amount ?? balance?.ui_token_amount?.amount ?? '0';
      try { row[side] += BigInt(amount || 0); } catch (_) {}
      const rawIndex = balance?.accountIndex ?? balance?.account_index;
      const accountIndex = rawIndex == null ? null : Number(rawIndex);
      if (Number.isInteger(accountIndex) && accountIndex >= 0 && accountKeys[accountIndex]) {
        row.accounts.add(accountKeys[accountIndex]);
      }
      candidates.set(balance.mint, row);
    }
  };
  collect(meta?.preTokenBalances, 'pre');
  collect(meta?.postTokenBalances, 'post');
  const ordered = [...candidates.values()].sort((left, right) => {
    const leftDelta = left.post >= left.pre ? left.post - left.pre : left.pre - left.post;
    const rightDelta = right.post >= right.pre ? right.post - right.pre : right.pre - right.post;
    return leftDelta === rightDelta ? 0 : (leftDelta > rightDelta ? -1 : 1);
  });
  const byAccount = new Map();
  for (const candidate of ordered) {
    for (const account of candidate.accounts) byAccount.set(account, candidate);
  }
  return { ordered, byAccount, fallbackDecimals };
}

function resolveTokenContext(contexts, baseTokenAccount) {
  const accountMatch = baseTokenAccount ? contexts.byAccount.get(baseTokenAccount) : null;
  const candidate = accountMatch || (contexts.ordered.length === 1 ? contexts.ordered[0] : null);
  if (!candidate) {
    return {
      mint: null,
      tokenDecimals: contexts.fallbackDecimals,
      tokenDecimalsSource: contexts.ordered.length ? 'AMBIGUOUS_TOKEN_BALANCES' : 'PUMP_DEFAULT',
      priceReliable: false,
    };
  }
  return {
    mint: candidate.mint,
    tokenDecimals: candidate.decimals ?? contexts.fallbackDecimals,
    tokenDecimalsSource: candidate.decimals == null ? 'PUMP_DEFAULT' : 'TOKEN_ACCOUNT_BALANCE',
    priceReliable: true,
  };
}

function extractProgramData(logMessages) {
  const stack = [];
  const rows = [];
  let outerInstructionIndex = -1;
  for (let logIndex = 0; logIndex < (logMessages || []).length; logIndex += 1) {
    const line = logMessages[logIndex];
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)]/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth === 1) outerInstructionIndex += 1;
      stack.push({ programId: invoke[1], depth });
      continue;
    }
    const done = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed)/.exec(line);
    if (done) {
      const index = stack.map((item) => item.programId).lastIndexOf(done[1]);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const data = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
    if (data) {
      rows.push({
        programId: stack[stack.length - 1]?.programId || null,
        instructionIndex: outerInstructionIndex >= 0 ? outerInstructionIndex : null,
        logIndex,
        data: Buffer.from(data[1], 'base64'),
      });
    }
  }
  return rows;
}

function feeFields(values) {
  // buybackFeeBasisPoints is reported by the event for fee allocation, but the
  // official PumpSwap quote SDK does not add it to the user-paid swap fee.
  const totalFeeBps = [
    values.lpFeeBasisPoints,
    values.protocolFeeBasisPoints,
    values.coinCreatorFeeBasisPoints,
  ].reduce((sum, value) => sum + (numeric(value) || 0), 0);
  return { ...values, totalFeeBps };
}

function reserveFields({ poolBaseReservesRaw, poolQuoteReservesRaw, virtualQuoteReservesRaw }, context) {
  const effectiveQuoteReservesRaw = BigInt(poolQuoteReservesRaw) + BigInt(virtualQuoteReservesRaw || 0);
  const baseTokens = rawToUnits(poolBaseReservesRaw, context.tokenDecimals);
  const quoteSol = rawToUnits(effectiveQuoteReservesRaw, 9);
  const reservePrice = baseTokens > 0 && quoteSol > 0 ? quoteSol / baseTokens : null;
  return {
    poolBaseReservesRaw: poolBaseReservesRaw.toString(),
    poolQuoteReservesRaw: poolQuoteReservesRaw.toString(),
    virtualQuoteReservesRaw: virtualQuoteReservesRaw.toString(),
    effectiveQuoteReservesRaw: effectiveQuoteReservesRaw.toString(),
    reservePrice: Number.isFinite(reservePrice) && reservePrice > 0 ? reservePrice : null,
  };
}

function decodeAmmBuy(data, context) {
  const reader = new BorshReader(data, 8);
  const chainTimestampMs = timestampMs(reader.i64());
  const baseAmountRaw = reader.u64();
  const maxQuoteAmountInRaw = reader.u64();
  const userBaseTokenReservesRaw = reader.u64();
  const userQuoteTokenReservesRaw = reader.u64();
  const poolBaseReservesRaw = reader.u64();
  const poolQuoteReservesRaw = reader.u64();
  const quoteAmountRaw = reader.u64();
  const lpFeeBasisPoints = reader.u64();
  const lpFeeRaw = reader.u64();
  const protocolFeeBasisPoints = reader.u64();
  const protocolFeeRaw = reader.u64();
  const quoteAmountInWithLpFeeRaw = reader.u64();
  const userQuoteAmountRaw = reader.u64();
  const pool = reader.pubkey();
  const wallet = reader.pubkey();

  const optional = {
    userBaseTokenAccount: null,
    userQuoteTokenAccount: null,
    protocolFeeRecipient: null,
    protocolFeeRecipientTokenAccount: null,
    coinCreator: null,
    coinCreatorFeeBasisPoints: 0n,
    coinCreatorFeeRaw: 0n,
    cashbackFeeBasisPoints: 0n,
    cashbackRaw: 0n,
    buybackFeeBasisPoints: 0n,
    buybackFeeRaw: 0n,
    virtualQuoteReservesRaw: 0n,
    canBoost: null,
    baseSupplyRaw: null,
  };
  if (reader.remaining() > 0) {
    optional.userBaseTokenAccount = reader.pubkey();
    optional.userQuoteTokenAccount = reader.pubkey();
    optional.protocolFeeRecipient = reader.pubkey();
    optional.protocolFeeRecipientTokenAccount = reader.pubkey();
    optional.coinCreator = reader.pubkey();
    optional.coinCreatorFeeBasisPoints = reader.u64();
    optional.coinCreatorFeeRaw = reader.u64();
    reader.bool();
    reader.u64();
    reader.u64();
    reader.u64();
    reader.i64();
    reader.u64();
    reader.string();
    optional.cashbackFeeBasisPoints = reader.u64();
    optional.cashbackRaw = reader.u64();
    optional.buybackFeeBasisPoints = reader.u64();
    optional.buybackFeeRaw = reader.u64();
    optional.virtualQuoteReservesRaw = reader.i128();
    optional.canBoost = reader.bool();
    if (reader.remaining() >= 8) optional.baseSupplyRaw = reader.u64();
  }

  const token = resolveTokenContext(context.tokenContexts, optional.userBaseTokenAccount);
  const tokenAmount = rawToUnits(baseAmountRaw, token.tokenDecimals);
  const solAmount = rawToUnits(userQuoteAmountRaw, 9);
  const reserve = reserveFields({
    poolBaseReservesRaw, poolQuoteReservesRaw,
    virtualQuoteReservesRaw: optional.virtualQuoteReservesRaw,
  }, token);
  return {
    type: 'ammTrade', market: 'PUMP_AMM', side: 'BUY',
    mint: token.mint, tokenDecimals: token.tokenDecimals,
    tokenDecimalsSource: token.tokenDecimalsSource, priceReliable: token.priceReliable,
    pool, wallet, chainTimestampMs, tokenAmount, solAmount,
    price: tokenAmount > 0 ? solAmount / tokenAmount : null,
    baseAmountRaw: baseAmountRaw.toString(),
    quoteAmountRaw: quoteAmountRaw.toString(),
    userQuoteAmountRaw: userQuoteAmountRaw.toString(),
    maxQuoteAmountInRaw: maxQuoteAmountInRaw.toString(),
    quoteAmountInWithLpFeeRaw: quoteAmountInWithLpFeeRaw.toString(),
    userBaseTokenReservesRaw: userBaseTokenReservesRaw.toString(),
    userQuoteTokenReservesRaw: userQuoteTokenReservesRaw.toString(),
    userBaseTokenAccount: optional.userBaseTokenAccount,
    userQuoteTokenAccount: optional.userQuoteTokenAccount,
    ...reserve,
    ...feeFields({
      lpFeeBasisPoints: numeric(lpFeeBasisPoints), lpFeeRaw: lpFeeRaw.toString(),
      protocolFeeBasisPoints: numeric(protocolFeeBasisPoints), protocolFeeRaw: protocolFeeRaw.toString(),
      coinCreator: optional.coinCreator,
      coinCreatorFeeBasisPoints: numeric(optional.coinCreatorFeeBasisPoints),
      coinCreatorFeeRaw: optional.coinCreatorFeeRaw.toString(),
      cashbackFeeBasisPoints: numeric(optional.cashbackFeeBasisPoints),
      cashbackRaw: optional.cashbackRaw.toString(),
      buybackFeeBasisPoints: numeric(optional.buybackFeeBasisPoints),
      buybackFeeRaw: optional.buybackFeeRaw.toString(),
    }),
    canBoost: optional.canBoost,
    baseSupplyRaw: optional.baseSupplyRaw?.toString() || null,
  };
}

function decodeAmmSell(data, context) {
  const reader = new BorshReader(data, 8);
  const chainTimestampMs = timestampMs(reader.i64());
  const baseAmountRaw = reader.u64();
  const minQuoteAmountOutRaw = reader.u64();
  const userBaseTokenReservesRaw = reader.u64();
  const userQuoteTokenReservesRaw = reader.u64();
  const poolBaseReservesRaw = reader.u64();
  const poolQuoteReservesRaw = reader.u64();
  const quoteAmountRaw = reader.u64();
  const lpFeeBasisPoints = reader.u64();
  const lpFeeRaw = reader.u64();
  const protocolFeeBasisPoints = reader.u64();
  const protocolFeeRaw = reader.u64();
  const quoteAmountOutWithoutLpFeeRaw = reader.u64();
  const userQuoteAmountRaw = reader.u64();
  const pool = reader.pubkey();
  const wallet = reader.pubkey();

  const optional = {
    userBaseTokenAccount: null,
    userQuoteTokenAccount: null,
    protocolFeeRecipient: null,
    protocolFeeRecipientTokenAccount: null,
    coinCreator: null,
    coinCreatorFeeBasisPoints: 0n,
    coinCreatorFeeRaw: 0n,
    cashbackFeeBasisPoints: 0n,
    cashbackRaw: 0n,
    buybackFeeBasisPoints: 0n,
    buybackFeeRaw: 0n,
    virtualQuoteReservesRaw: 0n,
    canBoost: null,
    baseSupplyRaw: null,
  };
  if (reader.remaining() > 0) {
    optional.userBaseTokenAccount = reader.pubkey();
    optional.userQuoteTokenAccount = reader.pubkey();
    optional.protocolFeeRecipient = reader.pubkey();
    optional.protocolFeeRecipientTokenAccount = reader.pubkey();
    optional.coinCreator = reader.pubkey();
    optional.coinCreatorFeeBasisPoints = reader.u64();
    optional.coinCreatorFeeRaw = reader.u64();
    optional.cashbackFeeBasisPoints = reader.u64();
    optional.cashbackRaw = reader.u64();
    optional.buybackFeeBasisPoints = reader.u64();
    optional.buybackFeeRaw = reader.u64();
    optional.virtualQuoteReservesRaw = reader.i128();
    optional.canBoost = reader.bool();
    if (reader.remaining() >= 8) optional.baseSupplyRaw = reader.u64();
  }

  const token = resolveTokenContext(context.tokenContexts, optional.userBaseTokenAccount);
  const tokenAmount = rawToUnits(baseAmountRaw, token.tokenDecimals);
  const solAmount = rawToUnits(userQuoteAmountRaw, 9);
  const reserve = reserveFields({
    poolBaseReservesRaw, poolQuoteReservesRaw,
    virtualQuoteReservesRaw: optional.virtualQuoteReservesRaw,
  }, token);
  return {
    type: 'ammTrade', market: 'PUMP_AMM', side: 'SELL',
    mint: token.mint, tokenDecimals: token.tokenDecimals,
    tokenDecimalsSource: token.tokenDecimalsSource, priceReliable: token.priceReliable,
    pool, wallet, chainTimestampMs, tokenAmount, solAmount,
    price: tokenAmount > 0 ? solAmount / tokenAmount : null,
    baseAmountRaw: baseAmountRaw.toString(),
    quoteAmountRaw: quoteAmountRaw.toString(),
    userQuoteAmountRaw: userQuoteAmountRaw.toString(),
    minQuoteAmountOutRaw: minQuoteAmountOutRaw.toString(),
    quoteAmountOutWithoutLpFeeRaw: quoteAmountOutWithoutLpFeeRaw.toString(),
    userBaseTokenReservesRaw: userBaseTokenReservesRaw.toString(),
    userQuoteTokenReservesRaw: userQuoteTokenReservesRaw.toString(),
    userBaseTokenAccount: optional.userBaseTokenAccount,
    userQuoteTokenAccount: optional.userQuoteTokenAccount,
    ...reserve,
    ...feeFields({
      lpFeeBasisPoints: numeric(lpFeeBasisPoints), lpFeeRaw: lpFeeRaw.toString(),
      protocolFeeBasisPoints: numeric(protocolFeeBasisPoints), protocolFeeRaw: protocolFeeRaw.toString(),
      coinCreator: optional.coinCreator,
      coinCreatorFeeBasisPoints: numeric(optional.coinCreatorFeeBasisPoints),
      coinCreatorFeeRaw: optional.coinCreatorFeeRaw.toString(),
      cashbackFeeBasisPoints: numeric(optional.cashbackFeeBasisPoints),
      cashbackRaw: optional.cashbackRaw.toString(),
      buybackFeeBasisPoints: numeric(optional.buybackFeeBasisPoints),
      buybackFeeRaw: optional.buybackFeeRaw.toString(),
    }),
    canBoost: optional.canBoost,
    baseSupplyRaw: optional.baseSupplyRaw?.toString() || null,
  };
}

function decodePumpMigration(data) {
  const reader = new BorshReader(data, 8);
  return {
    type: 'migration',
    user: reader.pubkey(),
    mint: reader.pubkey(),
    mintAmountRaw: reader.u64().toString(),
    solAmount: rawToUnits(reader.u64(), 9),
    poolMigrationFeeSol: rawToUnits(reader.u64(), 9),
    bondingCurve: reader.pubkey(),
    migratedAt: timestampMs(reader.i64()),
    pool: reader.pubkey(),
  };
}

function decodeEvent(data, programId, context) {
  if (programId === context.ammProgramId && matches(data, DISCRIMINATORS.ammBuy)) {
    return decodeAmmBuy(data, context);
  }
  if (programId === context.ammProgramId && matches(data, DISCRIMINATORS.ammSell)) {
    return decodeAmmSell(data, context);
  }
  if (programId === context.pumpProgramId && matches(data, DISCRIMINATORS.pumpMigration)) {
    return decodePumpMigration(data);
  }
  return null;
}

class PumpEventParser {
  constructor({ pumpProgramId, pumpAmmProgramId, wsolMint, defaultTokenDecimals = 6 }) {
    this.pumpProgramId = pumpProgramId;
    this.pumpAmmProgramId = pumpAmmProgramId;
    this.wsolMint = wsolMint;
    this.defaultTokenDecimals = defaultTokenDecimals;
  }

  parseTransaction(message, receivedAtMs = Date.now()) {
    const meta = extractMeta(message);
    if (!meta || meta.err) return [];
    const signature = extractSignature(message);
    const slot = extractSlot(message);
    const transactionIndex = extractTransactionIndex(message);
    const context = {
      tokenContexts: extractTokenContexts(
        message, meta, this.wsolMint, this.defaultTokenDecimals,
      ),
      pumpProgramId: this.pumpProgramId,
      ammProgramId: this.pumpAmmProgramId,
    };
    const events = [];
    const rows = extractProgramData(meta.logMessages || meta.log_messages || []);
    for (let eventIndex = 0; eventIndex < rows.length; eventIndex += 1) {
      const row = rows[eventIndex];
      try {
        const event = decodeEvent(row.data, row.programId, context);
        if (!event) continue;
        // A transaction may contain multiple non-WSOL mints. If the event's
        // base token account cannot be matched to its own mint/decimals, using
        // a transaction-wide fallback can create 1,000x price errors. Keep the
        // ambiguous event out of all price and strategy calculations.
        if (event.type === 'ammTrade' && !event.priceReliable) continue;
        events.push({
          ...event,
          signature,
          slot,
          transactionIndex,
          instructionIndex: row.instructionIndex,
          eventIndex,
          logIndex: row.logIndex,
          receivedAtMs,
          timestampMs: receivedAtMs,
          programId: row.programId,
          parseVersion: PUMP_PARSE_VERSION,
          ingestionMode: 'FULL_TRANSACTION_METADATA_V1',
          orderingConfidence: transactionIndex == null ? 'SLOT_CORRELATED' : 'STRICT',
        });
      } catch (_) {
        // Event layouts are append-only. An unknown or malformed event is kept
        // out of the strategy instead of being partially mispriced.
      }
    }
    return events;
  }

  async parseLogTransaction(message, receivedAtMs = Date.now(), resolvePool = null) {
    if (!message || message.err || !Array.isArray(message.logs) || !resolvePool) return [];
    const rows = extractProgramData(message.logs);
    const events = [];
    const emptyTokenContexts = {
      ordered: [], byAccount: new Map(), fallbackDecimals: this.defaultTokenDecimals,
    };
    for (let eventIndex = 0; eventIndex < rows.length; eventIndex += 1) {
      const row = rows[eventIndex];
      try {
        const preliminary = decodeEvent(row.data, row.programId, {
          tokenContexts: emptyTokenContexts,
          pumpProgramId: this.pumpProgramId,
          ammProgramId: this.pumpAmmProgramId,
        });
        if (!preliminary || preliminary.type !== 'ammTrade' || !preliminary.pool) continue;
        const token = await resolvePool(preliminary.pool);
        if (!token?.mint || !Number.isInteger(token.tokenDecimals)) continue;
        const candidate = {
          mint: token.mint,
          decimals: token.tokenDecimals,
          pre: 0n,
          post: 0n,
          accounts: new Set(preliminary.userBaseTokenAccount
            ? [preliminary.userBaseTokenAccount] : []),
        };
        const tokenContexts = {
          ordered: [candidate],
          byAccount: new Map([...candidate.accounts].map((account) => [account, candidate])),
          fallbackDecimals: token.tokenDecimals,
        };
        const event = decodeEvent(row.data, row.programId, {
          tokenContexts,
          pumpProgramId: this.pumpProgramId,
          ammProgramId: this.pumpAmmProgramId,
        });
        if (!event) continue;
        events.push({
          ...event,
          tokenDecimalsSource: token.tokenDecimalsSource || 'PUMPSWAP_POOL_ACCOUNT',
          priceReliable: true,
          signature: message.signature || null,
          slot: message.slot == null ? null : Number(message.slot),
          transactionIndex: message.transactionIndex == null
            ? null : Number(message.transactionIndex),
          instructionIndex: row.instructionIndex,
          eventIndex,
          logIndex: row.logIndex,
          receivedAtMs,
          timestampMs: receivedAtMs,
          programId: row.programId,
          parseVersion: PUMP_PARSE_VERSION,
          ingestionMode: 'LIGHTWEIGHT_LOGS_PLUS_STATUS_V1',
          orderingConfidence: message.transactionIndex == null ? 'SLOT_CORRELATED' : 'STRICT',
        });
      } catch (_) {
        // Unknown append-only event layouts and unresolved pools are excluded.
      }
    }
    return events;
  }
}

module.exports = {
  PumpEventParser,
  BorshReader,
  DISCRIMINATORS,
  extractProgramData,
  extractSignature,
  extractTransactionIndex,
  PUMP_PARSE_VERSION,
};
