'use strict';

require('dotenv').config();
const path = require('path');

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  return [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
}

function number(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function integer(name, fallback, bounds = {}) {
  return Math.trunc(number(name, fallback, bounds));
}

const positionSizesSol = [0.02, 0.05, 0.1];

const config = {
  pump: {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    ammProgramId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    wsolMint: 'So11111111111111111111111111111111111111112',
    defaultTokenDecimals: 6,
    quoteDecimals: 9,
  },
  stream: {
    endpoints: list('SDBR_GRPC_ENDPOINTS'),
    token: process.env.SDBR_GRPC_TOKEN || '',
    reconnectMinMs: integer('SDBR_RECONNECT_MIN_MS', 1_000, { min: 250 }),
    reconnectMaxMs: integer('SDBR_RECONNECT_MAX_MS', 30_000, { min: 1_000 }),
    staleTimeoutMs: integer('SDBR_STALE_TIMEOUT_MS', 15_000, { min: 5_000 }),
    staleCheckMs: integer('SDBR_STALE_CHECK_MS', 2_000, { min: 500 }),
    dedupTtlMs: integer('SDBR_DEDUP_TTL_MS', 300_000, { min: 10_000 }),
    dedupMax: integer('SDBR_DEDUP_MAX', 100_000, { min: 1_000 }),
  },
  storage: {
    dbPath: path.resolve(process.env.SDBR_DB_PATH || './data/sdbr-research.db'),
    flushMs: integer('SDBR_DB_FLUSH_MS', 500, { min: 25 }),
    batchMax: integer('SDBR_DB_BATCH_MAX', 500, { min: 1 }),
  },
  dashboard: {
    host: process.env.SDBR_DASHBOARD_HOST || '127.0.0.1',
    port: integer('SDBR_DASHBOARD_PORT', 8787, { min: 1, max: 65_535 }),
  },
  slotAssembler: {
    retentionSlots: 8,
  },
  dump: {
    preWindowMs: 5_000,
    priceFreshMs: 5_000,
    episodeCooldownMs: 10_000,
    stateRetentionMs: 30 * 60_000,
    profiles: [
      { id: 'D5-P15-Q20-A1', minSellToQuotePct: 5, minDropPct: 15, minPostQuoteSol: 20, minPoolAgeMs: 60_000 },
      { id: 'D10-P25-Q50-A5', minSellToQuotePct: 10, minDropPct: 25, minPostQuoteSol: 50, minPoolAgeMs: 5 * 60_000 },
      { id: 'D20-P40-Q100-A15', minSellToQuotePct: 20, minDropPct: 40, minPostQuoteSol: 100, minPoolAgeMs: 15 * 60_000 },
    ],
  },
  toxic: {
    toxicWallets: new Set(list('SDBR_TOXIC_WALLETS')),
    relatedWallets: new Set(list('SDBR_RELATED_WALLETS')),
    minPreTrades: 8,
    mechanicalMinBuySharePct: 90,
    mechanicalMinRunupPct: 40,
    maxLargestBuyerSharePct: 60,
    hardRejectReasons: new Set([
      'CREATOR_SELL',
      'KNOWN_TOXIC_SELLER',
      'KNOWN_RELATED_SELLER',
      'MECHANICAL_RUNUP',
      'BUYER_CONCENTRATION',
    ]),
  },
  recovery: {
    maxObservationMs: 20_000,
    maxSlotDelta: 40,
    minValidBuySol: number('SDBR_MIN_VALID_BUY_SOL', 0.05, { min: 0.000001 }),
    secondDumpMinSol: 1,
    secondDumpFractionOfInitial: 0.2,
    secondDumpMinPriceDropPct: 8,
    buyerStallMs: 1_000,
    profiles: [
      {
        id: 'PD-R1', maxSlotDelta: 4, minPriceBouncePct: 5,
        minDropRecoveryPct: 20, minUniqueBuyers: 2, minBuySol: 0.5,
        minBuyToDumpPct: 15, requirePositiveNetFlow: false,
      },
      {
        id: 'PD-R2', maxSlotDelta: 2, minPriceBouncePct: 5,
        minDropRecoveryPct: 30, minUniqueBuyers: 3, minBuySol: 0.5,
        minBuyToDumpPct: 25, requirePositiveNetFlow: true,
      },
      {
        id: 'PD-LQ', maxSlotDelta: 8, minPriceBouncePct: 5,
        minDropRecoveryPct: 20, minUniqueBuyers: 3, minBuySol: 1,
        minBuyToDumpPct: 15, requirePositiveNetFlow: true,
        minPoolAgeMs: 5 * 60_000, minPostQuoteSol: 50,
        requirePositiveFlow1sAnd3s: true,
      },
    ],
  },
  execution: {
    positionSizesSol,
    entryVariants: [
      { id: 'E100', kind: 'DELAY', delayMs: 100 },
      { id: 'E200', kind: 'DELAY', delayMs: 200 },
      { id: 'E400', kind: 'DELAY', delayMs: 400 },
      { id: 'E800', kind: 'DELAY', delayMs: 800 },
      { id: 'ENEXT', kind: 'NEXT_SLOT', delayMs: 0 },
    ],
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 2_000,
    exitGraceMs: 2_000,
    quoteModel: 'PUMPSWAP_CPMM_EVENT_FEES_V1',
    buySlippageBps: number('SDBR_BUY_SLIPPAGE_BPS', 100, { min: 0, max: 5_000 }),
    sellSlippageBps: number('SDBR_SELL_SLIPPAGE_BPS', 100, { min: 0, max: 5_000 }),
    baseTxFeeSol: number('SDBR_BASE_TX_FEE_SOL', 0.000005, { min: 0 }),
    priorityFeeSol: number('SDBR_PRIORITY_FEE_SOL', 0.0005, { min: 0 }),
    jitoTipSol: number('SDBR_JITO_TIP_SOL', 0, { min: 0 }),
    exitProfiles: [
      { id: 'H1', kind: 'FIXED', holdMs: 1_000 },
      { id: 'H2', kind: 'FIXED', holdMs: 2_000 },
      { id: 'H3', kind: 'FIXED', holdMs: 3_000 },
      { id: 'H5', kind: 'FIXED', holdMs: 5_000 },
      { id: 'H10', kind: 'FIXED', holdMs: 10_000 },
      { id: 'REC50', kind: 'RECOVERY', recoveryPct: 50, stopLossPct: -12, maxHoldMs: 10_000, flowExit: true },
      { id: 'REC75', kind: 'RECOVERY', recoveryPct: 75, stopLossPct: -12, maxHoldMs: 15_000, flowExit: true },
      { id: 'REC100', kind: 'RECOVERY', recoveryPct: 100, stopLossPct: -15, maxHoldMs: 20_000, flowExit: true },
      { id: 'RISK8', kind: 'RISK', stopLossPct: -8, maxHoldMs: 10_000, flowExit: true },
      { id: 'RISK15', kind: 'RISK', stopLossPct: -15, maxHoldMs: 20_000, flowExit: true },
    ],
  },
};

function validateConfig({ requireStream = true } = {}) {
  const errors = [];
  if (requireStream && config.stream.endpoints.length === 0) errors.push('SDBR_GRPC_ENDPOINTS is required');
  if (!config.execution.positionSizesSol.length) errors.push('at least one position size is required');
  if (!config.dump.profiles.length) errors.push('at least one dump profile is required');
  if (!config.recovery.profiles.length) errors.push('at least one recovery profile is required');
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return config;
}

module.exports = { config, validateConfig };
