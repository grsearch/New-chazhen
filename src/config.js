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

function idNumber(value) {
  return String(value).replace('-', 'N').replace('.', 'P');
}

function managedExitMatrix() {
  const profiles = [];
  const takeProfitPcts = [3, 5];
  const trailingProfiles = [
    { activationPct: 2, drawdownPct: 1 },
    { activationPct: 4, drawdownPct: 2 },
  ];
  const maxHoldMsValues = [30_000, 300_000];
  const stopLossPcts = [null, -12];
  for (const takeProfitPct of takeProfitPcts) {
    for (const trailing of trailingProfiles) {
      for (const maxHoldMs of maxHoldMsValues) {
        for (const stopLossPct of stopLossPcts) {
          profiles.push(Object.freeze({
            id: [
              `TP${idNumber(takeProfitPct)}`,
              `TR${idNumber(trailing.activationPct)}D${idNumber(trailing.drawdownPct)}`,
              `H${maxHoldMs / 1_000}`,
              stopLossPct == null ? 'SLN' : `SL${idNumber(stopLossPct)}`,
            ].join('-'),
            kind: 'MANAGED',
            fastTakeProfitPct: takeProfitPct,
            fastTakeProfitWindowMs: 5_000,
            trailingActivationPct: trailing.activationPct,
            trailingDrawdownPct: trailing.drawdownPct,
            maxHoldMs,
            stopLossPct,
          }));
        }
      }
    }
  }
  return Object.freeze(profiles);
}

function dumpSignalMatrix() {
  const sellBands = [
    { id: 'S', min: 5, max: 10 },
    { id: 'M', min: 10, max: 25 },
    { id: 'L', min: 25, max: Infinity },
  ];
  const dropBands = [
    { id: 'D8', min: 8, max: 15 },
    { id: 'D15', min: 15, max: 30 },
    { id: 'D30', min: 30, max: Infinity },
  ];
  return Object.freeze(sellBands.flatMap((sell) => dropBands.map((drop) => Object.freeze({
    id: `DBM-${sell.id}-${drop.id}`,
    minSellSol: sell.min,
    maxSellSol: sell.max,
    minDropPct: drop.min,
    maxDropPct: drop.max,
    positionSizesSol: Object.freeze([1]),
  }))));
}

const positionSizesSol = [1, 2, 5];
const maxDumpDropPct = number('SDBR_MAX_DUMP_DROP_PCT', 99, { min: 1, max: 99 });
const streamToken = process.env.SDBR_GRPC_TOKEN || '';
const streamMode = (process.env.SDBR_STREAM_MODE || 'logs-status').trim().toLowerCase();

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
    token: streamToken,
    mode: streamMode,
    rpcUrl: process.env.SDBR_RPC_URL
      || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(streamToken)}`,
    // Pump Program carries the very high-volume pre-migration bonding-curve flow.
    // Same-Slot research only needs PumpSwap; exact migration timestamps are optional.
    includePumpLifecycle: boolean('SDBR_INCLUDE_PUMP_LIFECYCLE', false),
    reconnectMinMs: integer('SDBR_RECONNECT_MIN_MS', 1_000, { min: 250 }),
    reconnectMaxMs: integer('SDBR_RECONNECT_MAX_MS', 30_000, { min: 1_000 }),
    staleTimeoutMs: integer('SDBR_STALE_TIMEOUT_MS', 15_000, { min: 5_000 }),
    staleCheckMs: integer('SDBR_STALE_CHECK_MS', 2_000, { min: 500 }),
    dedupTtlMs: integer('SDBR_DEDUP_TTL_MS', 300_000, { min: 10_000 }),
    dedupMax: integer('SDBR_DEDUP_MAX', 100_000, { min: 1_000 }),
    joinTtlMs: integer('SDBR_LOG_STATUS_JOIN_TTL_MS', 30_000, { min: 1_000, max: 60_000 }),
    joinQualityWindowMs: integer('SDBR_LOG_STATUS_JOIN_WINDOW_MS', 300_000,
      { min: 60_000, max: 1_800_000 }),
    joinQualityBucketMs: integer('SDBR_LOG_STATUS_JOIN_BUCKET_MS', 1_000,
      { min: 250, max: 60_000 }),
    poolResolveRetryMs: integer('SDBR_POOL_RESOLVE_RETRY_MS', 30_000,
      { min: 1_000, max: 600_000 }),
    poolCacheMax: integer('SDBR_POOL_CACHE_MAX', 200_000, { min: 1_000 }),
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
    summaryCacheMs: integer('SDBR_DASHBOARD_SUMMARY_CACHE_MS', 30_000,
      { min: 5_000, max: 300_000 }),
  },
  health: {
    checkIntervalMs: integer('SDBR_HEALTH_CHECK_MS', 60_000, { min: 5_000 }),
    healthyLogIntervalMs: integer('SDBR_HEALTH_LOG_MS', 600_000, { min: 60_000 }),
    startupGraceMs: integer('SDBR_HEALTH_STARTUP_GRACE_MS', 180_000, { min: 0 }),
    maxEventStaleMs: integer('SDBR_HEALTH_MAX_EVENT_STALE_MS', 120_000, { min: 30_000 }),
    maxPendingWrites: integer('SDBR_HEALTH_MAX_PENDING_WRITES', 5_000, { min: 1 }),
    minDiskFreeBytes: number('SDBR_HEALTH_MIN_DISK_FREE_GB', 10, { min: 1 }) * 1024 ** 3,
    minDiskFreePct: number('SDBR_HEALTH_MIN_DISK_FREE_PCT', 10, { min: 1, max: 50 }),
    minimumJoinSamples: integer('SDBR_HEALTH_MIN_JOIN_SAMPLES', 100, { min: 10 }),
    minimumJoinRatePct: number('SDBR_HEALTH_MIN_JOIN_RATE_PCT', 90, { min: 1, max: 100 }),
    recoverableConsecutiveChecks: integer('SDBR_HEALTH_RECOVERY_CHECKS', 2, { min: 1 }),
    recoveryCooldownMs: integer('SDBR_HEALTH_RECOVERY_COOLDOWN_MS', 120_000,
      { min: 30_000, max: 3_600_000 }),
    recoveryBackoffMultiplier: number('SDBR_HEALTH_RECOVERY_BACKOFF_MULTIPLIER', 2,
      { min: 1, max: 10 }),
    recoveryMaxCooldownMs: integer('SDBR_HEALTH_RECOVERY_MAX_COOLDOWN_MS', 900_000,
      { min: 30_000, max: 3_600_000 }),
    recoveryMaxAttempts: integer('SDBR_HEALTH_RECOVERY_MAX_ATTEMPTS', 3,
      { min: 1, max: 10 }),
    recoveryResetHealthyMs: integer('SDBR_HEALTH_RECOVERY_RESET_HEALTHY_MS', 300_000,
      { min: 60_000, max: 3_600_000 }),
    fatalConsecutiveChecks: integer('SDBR_HEALTH_FATAL_CHECKS', 5, { min: 2 }),
    exitOnFatal: boolean('SDBR_HEALTH_EXIT_ON_FATAL', true),
  },
  slotAssembler: {
    retentionSlots: 8,
  },
  dump: {
    preWindowMs: 5_000,
    priceFreshMs: 5_000,
    // Signature/event de-duplication handles duplicate parser deliveries.  Zero
    // cooldown preserves every independently ordered PumpSwap sell pressure event.
    episodeCooldownMs: integer('SDBR_DUMP_EPISODE_COOLDOWN_MS', 0, { min: 0 }),
    stateRetentionMs: 30 * 60_000,
    maxDropPct: maxDumpDropPct,
    profiles: [
      // PumpSwap-only exhaustive intake.  The AMM venue is already post-migration;
      // age, liquidity and toxicity remain recorded features rather than intake gates.
      {
        id: 'PUMPSWAP-ALL-DUMPS', minSellSol: 0, minSellToQuotePct: 0,
        minDropPct: 0, minPostQuoteSol: 0, minPoolAgeMs: 0,
      },
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
    // Legacy next-slot recovery research is retained only for historical
    // database/export compatibility. Production runs the direct dump matrix.
    enabled: false,
    maxObservationMs: 20_000,
    maxSlotDelta: 40,
    minValidBuySol: number('SDBR_MIN_VALID_BUY_SOL', 0.1, { min: 0.000001 }),
    secondDumpMinSol: 1,
    secondDumpFractionOfInitial: 0.2,
    secondDumpMinPriceDropPct: 8,
    buyerStallMs: 1_000,
    maxReportedRecoveryPct: number('SDBR_MAX_REPORTED_RECOVERY_PCT', 500, {
      min: 100, max: 10_000,
    }),
    profiles: [
      // Causal N+1 research milestones.  These deliberately use broad gates and
      // retain toxic-labelled dumps as negative controls.  Later analysis ranks
      // them by absorptionScore instead of treating every confirmation as a
      // live-trading signal.
      {
        id: 'N1-FB', researchOnly: true, allowToxicResearch: true,
        minSlotDelta: 1, maxSlotDelta: 1, minPriceBouncePct: 0,
        minDropRecoveryPct: 0, minUniqueBuyers: 1, minBuySol: 0.1,
        minBuyToDumpPct: 1, requirePositiveNetFlow: false,
      },
      {
        id: 'N1-A5', researchOnly: true, allowToxicResearch: true,
        minSlotDelta: 1, maxSlotDelta: 1, minPriceBouncePct: 0,
        minDropRecoveryPct: 0, minUniqueBuyers: 1, minBuySol: 0.1,
        minBuyToDumpPct: 5, requirePositiveNetFlow: false,
      },
      {
        id: 'N1-P2', researchOnly: true, allowToxicResearch: true,
        minSlotDelta: 1, maxSlotDelta: 1, minPriceBouncePct: 2,
        minDropRecoveryPct: 0, minUniqueBuyers: 1, minBuySol: 0.1,
        minBuyToDumpPct: 1, requirePositiveNetFlow: false,
      },
      {
        id: 'N1-B2', researchOnly: true, allowToxicResearch: true,
        minSlotDelta: 1, maxSlotDelta: 1, minPriceBouncePct: 0,
        minDropRecoveryPct: 0, minUniqueBuyers: 2, minBuySol: 0.1,
        minBuyToDumpPct: 1, requirePositiveNetFlow: false,
      },
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
  walletResearch: {
    // The observation-wallet experiment is retired. Keep the shape so old
    // exports and focused unit tests remain readable, but never collect it.
    enabled: false,
    wallets: new Set(),
  },
  dumpBounceMatrix: Object.freeze({
    enabled: boolean('SDBR_DUMP_BOUNCE_MATRIX_ENABLED', true),
    // Each qualifying dump maps to exactly one size x impact bucket.  Repeated
    // dumps create independent lots, so later entries never overwrite earlier ones.
    signalProfiles: dumpSignalMatrix(),
    entryVariants: Object.freeze([
      Object.freeze({ id: 'E0', kind: 'DELAY', delayMs: 0 }),
      Object.freeze({ id: 'E100', kind: 'DELAY', delayMs: 100 }),
      Object.freeze({ id: 'E300', kind: 'DELAY', delayMs: 300 }),
    ]),
    exitProfiles: managedExitMatrix(),
    entryTimeoutMs: integer('SDBR_DUMP_MATRIX_ENTRY_TIMEOUT_MS', 5_000, { min: 250 }),
    exitDelayMs: integer('SDBR_DUMP_MATRIX_EXIT_DELAY_MS', 0, { min: 0 }),
    exitTimeoutMs: integer('SDBR_DUMP_MATRIX_EXIT_TIMEOUT_MS', 3_000, { min: 100 }),
    exitGraceMs: integer('SDBR_DUMP_MATRIX_EXIT_GRACE_MS', 30_000, { min: 0 }),
    quoteModel: 'PUMPSWAP_DIRECT_DUMP_MANAGED_V1',
    executionOverrides: Object.freeze({
      baseTxFeeSol: number('SDBR_DUMP_MATRIX_BASE_TX_FEE_SOL', 0.000005, { min: 0 }),
      priorityFeeSol: number('SDBR_DUMP_MATRIX_PRIORITY_FEE_SOL', 0.0001, { min: 0 }),
      jitoTipSol: number('SDBR_DUMP_MATRIX_JITO_TIP_SOL', 0, { min: 0 }),
    }),
  }),
  sameSlotShadow: {
    // Retired in favour of the post-migration direct-dump managed matrix.
    // Intentionally not environment-overridable, so an old .env cannot revive it.
    enabled: false,
    targetRanks: [1, 2],
    primaryProfileId: 'R2-A1',
    primaryCohortStage: 'BROAD_RESEARCH_V1',
    minMeaningfulBuySol: number('SDBR_MIN_MEANINGFUL_BUY_SOL', 0.1, { min: 0.000001 }),
    minMeaningfulBuyToDumpPct: number('SDBR_MIN_MEANINGFUL_BUY_TO_DUMP_PCT', 1, {
      min: 0.01, max: 100,
    }),
    minRank2TriggerBuySol: number('SDBR_RANK2_MIN_TRIGGER_BUY_SOL', 2, { min: 0.01 }),
    strongRank2TriggerBuySol: number('SDBR_RANK2_STRONG_TRIGGER_BUY_SOL', 5, { min: 0.01 }),
    positionSizesSol,
    exitHorizonsMs: [250, 500, 1_000, 2_000],
    // 1 SOL receives the full horizon grid; 2/5 SOL remain capacity
    // sensitivity checks at the two fastest exits.
    exitHorizonsByPositionSol: Object.freeze({
      1: [250, 500, 1_000, 2_000],
      2: [250, 500],
      5: [250, 500],
    }),
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
    candidate: Object.freeze({
      // Kept only so historical exports remain readable.  It is no longer the
      // intake gate or the primary research direction.
      enabled: false,
      profileId: 'R2-B10-Q500-V1',
      cohortStage: 'HOLDOUT_B10_Q500_V1',
      minTriggerBuySol: 10,
      minPostQuoteSol: 500,
      maxDropPct: 40,
      primaryPositionSol: 1,
      primaryExitHorizonMs: 250,
      minimumEpisodes: 100,
      minimumMints: 50,
      minimumFullLossProfitFactor: 1.3,
      noExitLossPct: -100,
      jitoTipSol: 0.01,
    }),
  },
  causalBackrun: Object.freeze({
    // Frozen legacy research definitions remain export-readable but inactive.
    enabled: false,
    // Frozen forward-validation cohorts.  These are intentionally not
    // configurable through env vars, so tomorrow's sample cannot be tuned
    // after seeing its outcome.
    profiles: Object.freeze([
      Object.freeze({
        id: 'R2-ABS10-V1', minFirstBuySol: 10, minDropPct: 5, maxDropPct: 40,
      }),
      Object.freeze({
        id: 'R2-ABS5-D15-30-V1', minFirstBuySol: 5, minDropPct: 15, maxDropPct: 30,
      }),
    ]),
    entryVariants: Object.freeze([
      Object.freeze({ id: 'E50', kind: 'DELAY', delayMs: 50 }),
      Object.freeze({ id: 'E100', kind: 'DELAY', delayMs: 100 }),
      Object.freeze({ id: 'E200', kind: 'DELAY', delayMs: 200 }),
      Object.freeze({ id: 'E400', kind: 'DELAY', delayMs: 400 }),
      Object.freeze({ id: 'NEXT_SLOT', kind: 'NEXT_SLOT', delayMs: 0 }),
    ]),
    positionSizesSol: Object.freeze([1]),
    exitProfiles: Object.freeze([
      Object.freeze({ id: 'H010', kind: 'FIXED', holdMs: 100 }),
      Object.freeze({ id: 'H025', kind: 'FIXED', holdMs: 250 }),
      Object.freeze({ id: 'H05', kind: 'FIXED', holdMs: 500 }),
      Object.freeze({ id: 'H1', kind: 'FIXED', holdMs: 1_000 }),
    ]),
    combinationGrid: Object.freeze([
      Object.freeze({
        positionSol: 1,
        entryVariantIds: Object.freeze(['E50', 'E100', 'E200', 'E400', 'NEXT_SLOT']),
        exitProfileIds: Object.freeze(['H010', 'H025', 'H05', 'H1']),
      }),
    ]),
    entryTimeoutMs: 2_000,
    exitTimeoutMs: 2_000,
    exitGraceMs: 2_000,
    triggerRetentionMs: 2_000,
    quoteModel: 'PUMPSWAP_CAUSAL_BACKRUN_FROZEN_V1',
  }),
  executionProbe: {
    enabled: boolean('SDBR_EXECUTION_PROBE_ENABLED', false),
    sendEnabled: false,
    model: 'SOLANA_V0_EPHEMERAL_NOOP_V1',
  },
  execution: {
    positionSizesSol,
    entryVariants: [
      { id: 'E0', kind: 'DELAY', delayMs: 0 },
      { id: 'E100', kind: 'DELAY', delayMs: 100 },
      { id: 'E250', kind: 'DELAY', delayMs: 250 },
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
      { id: 'H025', kind: 'FIXED', holdMs: 250 },
      { id: 'H05', kind: 'FIXED', holdMs: 500 },
      { id: 'H1', kind: 'FIXED', holdMs: 1_000 },
      { id: 'H2', kind: 'FIXED', holdMs: 2_000 },
    ],
    // Avoid the old 3 x 5 x 10 Cartesian explosion.  The full timing grid is
    // tested at 1 SOL; larger sizes are liquidity sensitivity checks only.
    combinationGrid: Object.freeze([
      { positionSol: 1, entryVariantIds: ['E0', 'E100', 'E250'], exitProfileIds: ['H025', 'H05', 'H1', 'H2'] },
      { positionSol: 2, entryVariantIds: ['E100'], exitProfileIds: ['H025', 'H05'] },
      { positionSol: 5, entryVariantIds: ['E100'], exitProfileIds: ['H025', 'H05'] },
    ]),
  },
};

function validateConfig({ requireStream = true } = {}) {
  const errors = [];
  if (requireStream && config.stream.endpoints.length === 0) errors.push('SDBR_GRPC_ENDPOINTS is required');
  if (requireStream && !config.stream.token) errors.push('SDBR_GRPC_TOKEN is required');
  if (!['logs-status', 'full-transactions'].includes(config.stream.mode)) {
    errors.push('SDBR_STREAM_MODE must be logs-status or full-transactions');
  }
  if (config.stream.mode === 'logs-status' && config.stream.includePumpLifecycle) {
    errors.push('SDBR_INCLUDE_PUMP_LIFECYCLE must be false in logs-status mode');
  }
  if (!config.execution.positionSizesSol.length) errors.push('at least one position size is required');
  if (config.dumpBounceMatrix.enabled && !config.dumpBounceMatrix.signalProfiles.length) {
    errors.push('at least one direct dump signal profile is required');
  }
  if (config.dumpBounceMatrix.enabled && !config.dumpBounceMatrix.exitProfiles.length) {
    errors.push('at least one direct dump exit profile is required');
  }
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
