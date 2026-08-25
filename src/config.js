'use strict';

require('dotenv').config();
const path = require('path');
const { PUMP_PARSE_VERSION } = require('./core/PumpEventParser');

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

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function numberList(name, fallback, bounds = {}) {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  return [...new Set(raw.split(',').map((item) => {
    const value = Number(item.trim());
    if (!Number.isFinite(value)
      || value < (bounds.min ?? -Infinity) || value > (bounds.max ?? Infinity)) {
      throw new Error(`${name} contains an invalid number: ${item}`);
    }
    return value;
  }))];
}

const positionSizesSol = [1, 2, 5];
const maxDumpDropPct = number('SDBR_MAX_DUMP_DROP_PCT', 40, { min: 1, max: 99 });

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
    // Pump Program carries the very high-volume pre-migration bonding-curve flow.
    // Same-Slot research only needs PumpSwap; exact migration timestamps are optional.
    includePumpLifecycle: boolean('SDBR_INCLUDE_PUMP_LIFECYCLE', false),
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
    storeTradeRawJson: boolean('SDBR_STORE_TRADE_RAW_JSON', false),
    tradeRetentionMs: integer('SDBR_TRADE_RETENTION_DAYS', 30, { min: 1, max: 90 }) * 86_400_000,
    slotSummaryRetentionMs: integer('SDBR_SLOT_RETENTION_DAYS', 30, { min: 1, max: 90 }) * 86_400_000,
    maintenanceIntervalMs: integer('SDBR_DB_MAINTENANCE_MS', 600_000, { min: 60_000 }),
    maintenanceBatchMax: integer('SDBR_DB_MAINTENANCE_BATCH', 10_000, { min: 100, max: 100_000 }),
    maxDumpDropPct,
    acceptedDumpParseVersion: PUMP_PARSE_VERSION,
  },
  dashboard: {
    host: process.env.SDBR_DASHBOARD_HOST || '127.0.0.1',
    port: integer('SDBR_DASHBOARD_PORT', 8787, { min: 1, max: 65_535 }),
  },
  health: {
    checkIntervalMs: integer('SDBR_HEALTH_CHECK_MS', 60_000, { min: 5_000 }),
    healthyLogIntervalMs: integer('SDBR_HEALTH_LOG_MS', 600_000, { min: 60_000 }),
    startupGraceMs: integer('SDBR_HEALTH_STARTUP_GRACE_MS', 60_000, { min: 0 }),
    maxEventStaleMs: integer('SDBR_HEALTH_MAX_EVENT_STALE_MS', 120_000, { min: 30_000 }),
    maxPendingWrites: integer('SDBR_HEALTH_MAX_PENDING_WRITES', 5_000, { min: 1 }),
    minDiskFreeBytes: number('SDBR_HEALTH_MIN_DISK_FREE_GB', 10, { min: 1 }) * 1024 ** 3,
    minDiskFreePct: number('SDBR_HEALTH_MIN_DISK_FREE_PCT', 10, { min: 1, max: 50 }),
    fatalConsecutiveChecks: integer('SDBR_HEALTH_FATAL_CHECKS', 5, { min: 2 }),
    exitOnFatal: boolean('SDBR_HEALTH_EXIT_ON_FATAL', true),
  },
  slotAssembler: {
    retentionSlots: 8,
  },
  dump: {
    preWindowMs: 5_000,
    priceFreshMs: 5_000,
    episodeCooldownMs: 10_000,
    stateRetentionMs: 30 * 60_000,
    maxDropPct: maxDumpDropPct,
    profiles: [
      { id: 'D5-P15-Q20-A1', minSellToQuotePct: 5, minDropPct: 15, minPostQuoteSol: 20, minPoolAgeMs: 60_000 },
      { id: 'D10-P25-Q50-A5', minSellToQuotePct: 10, minDropPct: 25, minPostQuoteSol: 50, minPoolAgeMs: 5 * 60_000 },
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
    maxReportedRecoveryPct: number('SDBR_MAX_REPORTED_RECOVERY_PCT', 500, {
      min: 100, max: 10_000,
    }),
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
  sameSlotShadow: {
    enabled: boolean('SDBR_SAME_SLOT_SHADOW_ENABLED', true),
    targetRanks: [1, 2],
    primaryProfileId: 'R2-B5',
    primaryCohortStage: 'HOLDOUT_B5_V1',
    minRank2TriggerBuySol: number('SDBR_RANK2_MIN_TRIGGER_BUY_SOL', 2, { min: 0.01 }),
    strongRank2TriggerBuySol: number('SDBR_RANK2_STRONG_TRIGGER_BUY_SOL', 5, { min: 0.01 }),
    positionSizesSol,
    exitHorizonsMs: [100, 250, 500],
    exitTimeoutMs: integer('SDBR_SAME_SLOT_EXIT_TIMEOUT_MS', 2_000, { min: 100 }),
    rescueHorizonsMs: numberList('SDBR_SAME_SLOT_RESCUE_HORIZONS_MS', [5_000, 10_000], {
      min: 1_000, max: 60_000,
    }).sort((left, right) => left - right),
    rescueTimeoutMs: integer('SDBR_SAME_SLOT_RESCUE_TIMEOUT_MS', 2_000, { min: 100 }),
    episodeRetentionMs: integer('SDBR_SAME_SLOT_RETENTION_MS', 5_000, { min: 2_000 }),
    quoteModel: 'PUMPSWAP_SAME_SLOT_PUBLIC_RESERVE_PATH_V2',
    buySlippageBps: number('SDBR_BUY_SLIPPAGE_BPS', 100, { min: 0, max: 5_000 }),
    sellSlippageBps: number('SDBR_SELL_SLIPPAGE_BPS', 100, { min: 0, max: 5_000 }),
    maxImmediateRoundTripLossPct: number('SDBR_MAX_ROUND_TRIP_LOSS_PCT', 8, { min: 0, max: 100 }),
    maxEntryLiquidityUsagePct: number('SDBR_MAX_ENTRY_LIQUIDITY_USAGE_PCT', 10, { min: 0.1, max: 100 }),
    maxExitLiquidityUsagePct: number('SDBR_MAX_EXIT_LIQUIDITY_USAGE_PCT', 10, { min: 0.1, max: 100 }),
    baseTxFeeSol: number('SDBR_BASE_TX_FEE_SOL', 0.000005, { min: 0 }),
    priorityFeeSol: number('SDBR_PRIORITY_FEE_SOL', 0.0005, { min: 0 }),
    jitoTipSol: number('SDBR_JITO_TIP_SOL', 0, { min: 0 }),
    jitoTipScenariosSol: numberList('SDBR_JITO_TIP_SCENARIOS_SOL', [0, 0.005, 0.01, 0.02], {
      min: 0, max: 10,
    }),
    noExitScenarioLossPcts: numberList('SDBR_NO_EXIT_SCENARIO_LOSS_PCTS', [-15, -100], {
      min: -100, max: 0,
    }),
    maxTradeSol: number('SDBR_DATA_MAX_TRADE_SOL', 1_000, { min: 1 }),
    maxQuoteReserveSol: number('SDBR_DATA_MAX_QUOTE_RESERVE_SOL', 10_000, { min: 20 }),
    maxTradeToQuotePct: number('SDBR_DATA_MAX_TRADE_TO_QUOTE_PCT', 50, {
      min: 1, max: 1_000,
    }),
    maxEventReservePriceDeviationPct: number(
      'SDBR_DATA_MAX_EVENT_RESERVE_DEVIATION_PCT', 100, { min: 1, max: 10_000 },
    ),
    maxQuoteReserveChangeMultiple: number(
      'SDBR_DATA_MAX_QUOTE_RESERVE_CHANGE_MULTIPLE', 5, { min: 1.1, max: 1_000 },
    ),
    parseBudgetMs: number('SDBR_SPEED_PARSE_BUDGET_MS', 2, { min: 0 }),
    buildBudgetMs: number('SDBR_SPEED_BUILD_BUDGET_MS', 5, { min: 0 }),
    signBudgetMs: number('SDBR_SPEED_SIGN_BUDGET_MS', 1, { min: 0 }),
    sendBudgetMs: number('SDBR_SPEED_SEND_BUDGET_MS', 15, { min: 0 }),
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
    quoteModel: 'PUMPSWAP_CPMM_CAUSAL_CAPACITY_V4',
    buySlippageBps: number('SDBR_BUY_SLIPPAGE_BPS', 100, { min: 0, max: 5_000 }),
    sellSlippageBps: number('SDBR_SELL_SLIPPAGE_BPS', 100, { min: 0, max: 5_000 }),
    maxImmediateRoundTripLossPct: number('SDBR_MAX_ROUND_TRIP_LOSS_PCT', 8, { min: 0, max: 100 }),
    maxEntryLiquidityUsagePct: number('SDBR_MAX_ENTRY_LIQUIDITY_USAGE_PCT', 10, { min: 0.1, max: 100 }),
    maxExitLiquidityUsagePct: number('SDBR_MAX_EXIT_LIQUIDITY_USAGE_PCT', 10, { min: 0.1, max: 100 }),
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
  if (!config.sameSlotShadow.positionSizesSol.length) errors.push('at least one Same-Slot position size is required');
  if (config.sameSlotShadow.strongRank2TriggerBuySol
    <= config.sameSlotShadow.minRank2TriggerBuySol) {
    errors.push('SDBR_RANK2_STRONG_TRIGGER_BUY_SOL must exceed SDBR_RANK2_MIN_TRIGGER_BUY_SOL');
  }
  if (!config.dump.profiles.length) errors.push('at least one dump profile is required');
  if (!config.recovery.profiles.length) errors.push('at least one recovery profile is required');
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return config;
}

module.exports = { config, validateConfig };
