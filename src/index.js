'use strict';

const { config, validateConfig } = require('./config');
const { PumpEventParser } = require('./core/PumpEventParser');
const { PumpFlowStream } = require('./core/PumpFlowStream');
const { PumpPoolResolver } = require('./core/PumpPoolResolver');
const { SlotAssembler } = require('./core/SlotAssembler');
const { PostDumpRecoveryEngine } = require('./core/PostDumpRecoveryEngine');
const { ResearchStore } = require('./data/ResearchStore');
const { DashboardServer } = require('./server/DashboardServer');
const { RuntimeHealthMonitor } = require('./core/RuntimeHealthMonitor');

async function main() {
  validateConfig({ requireStream: true });
  const store = new ResearchStore({
    ...config.storage,
    sameSlotQuoteModel: config.sameSlotShadow.quoteModel,
    sameSlotPrimaryProfileId: config.sameSlotShadow.primaryProfileId,
    sameSlotPrimaryCohortStage: config.sameSlotShadow.primaryCohortStage,
    sameSlotStrongTriggerBuySol: config.sameSlotShadow.strongRank2TriggerBuySol,
    sameSlotMaxTradeSol: config.sameSlotShadow.maxTradeSol,
    sameSlotNoExitScenarioLossPcts: config.sameSlotShadow.noExitScenarioLossPcts,
    sameSlotJitoTipScenariosSol: config.sameSlotShadow.jitoTipScenariosSol,
    sameSlotCandidate: config.sameSlotShadow.candidate,
    maxReportedRecoveryPct: config.recovery.maxReportedRecoveryPct,
  });
  const removedInvalidFeeSimulations = store.deleteSimulationsByQuoteModels([
    'PUMPSWAP_CPMM_EVENT_FEES_V1',
    'PUMPSWAP_CPMM_EXECUTABLE_FEES_V2',
    'PUMPSWAP_CPMM_CAUSAL_CAPACITY_V3',
  ]);
  if (removedInvalidFeeSimulations > 0) {
    console.log(`Removed ${removedInvalidFeeSimulations} simulations from invalid legacy execution models.`);
  }
  const removedLegacySimulations = store.deleteSimulationsByPositionSizes([0.02, 0.05, 0.1]);
  if (removedLegacySimulations > 0) {
    console.log(`Removed ${removedLegacySimulations} obsolete 0.02/0.05/0.1 SOL simulations.`);
  }
  const parser = new PumpEventParser({
    pumpProgramId: config.pump.programId,
    pumpAmmProgramId: config.pump.ammProgramId,
    wsolMint: config.pump.wsolMint,
    defaultTokenDecimals: config.pump.defaultTokenDecimals,
  });
  const slots = new SlotAssembler(config.slotAssembler);
  const engine = new PostDumpRecoveryEngine({ config, store });
  const stream = new PumpFlowStream({ config });
  const poolResolver = config.stream.mode === 'logs-status'
    ? new PumpPoolResolver({ config }) : null;
  let streamState = { state: 'STARTING' };
  let runtimeHealth = null;
  slots.on('slotFinalized', (summary) => store.recordSlotSummary(summary));
  stream.on('state', (state) => { streamState = state; });
  stream.on('streamError', ({ error, phase, retryInMs }) => {
    console.error(`[LaserStream:${phase}] ${error.message}; retry in ${retryInMs}ms`);
  });
  const observeParsed = (events) => {
    for (const parsed of events) engine.observe(slots.ingest(parsed));
  };
  stream.on('transaction', (transaction, context) => {
    try {
      observeParsed(parser.parseTransaction(transaction, context.receivedAtMs));
    } catch (error) {
      engine.metrics.errors += 1;
      console.error('[ingestion]', error.message);
    }
  });
  stream.on('logTransaction', async (transaction, context) => {
    try {
      const events = await parser.parseLogTransaction(
        transaction,
        context.receivedAtMs,
        (pool) => poolResolver.resolve(pool),
      );
      observeParsed(events);
    } catch (error) {
      engine.metrics.errors += 1;
      console.error('[lightweight-ingestion]', error.message);
    }
  });

  const componentHealth = () => ({
    generatedAtMs: Date.now(),
    stream: {
      ...stream.health(),
      state: streamState.state,
      reason: streamState.reason || null,
      phase: streamState.phase || null,
      retryInMs: streamState.retryInMs || null,
    },
    slotAssembler: slots.health(),
    poolResolver: poolResolver?.health() || { mode: 'FULL_TRANSACTION_TOKEN_BALANCES' },
    engine: engine.health(),
    store: store.health(),
  });
  const dashboard = new DashboardServer({
    config: config.dashboard,
    store,
    health: () => ({
      ...componentHealth(),
      runtime: runtimeHealth?.health() || { enabled: true, status: 'STARTING' },
    }),
  });
  const timer = setInterval(() => {
    try { engine.advanceTime(); } catch (error) { console.error('[advance]', error.message); }
  }, 250);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    runtimeHealth?.stop();
    console.log(`Stopping on ${signal}...`);
    await stream.stop();
    engine.advanceTime();
    await dashboard.stop();
    store.close();
  };
  process.once('SIGINT', () => stop('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => stop('SIGTERM').then(() => process.exit(0)));

  await dashboard.start();
  console.log(`Dashboard: http://${config.dashboard.host}:${config.dashboard.port}`);
  console.log('Mode: research only; transaction sending is not implemented.');
  console.log(`LaserStream subscription: ${config.stream.mode === 'logs-status'
    ? 'PumpSwap logs + lightweight transaction status; full metadata disabled'
    : (config.stream.includePumpLifecycle
      ? 'full PumpSwap + Pump lifecycle' : 'full PumpSwap transactions')}.`);
  await stream.start();
  runtimeHealth = new RuntimeHealthMonitor({
    config: config.health,
    healthProvider: componentHealth,
    onRecoverable: (snapshot) => {
      console.warn(`[Health] RECOVERY: ${snapshot.recoverableIssues.join(', ')}`);
      if (stopping) return;
      const requested = stream.requestReconnect('HEALTH_JOIN_QUALITY_RECOVERY');
      if (!requested) console.warn('[Health] stream recovery already in progress');
    },
    onFatal: async (snapshot) => {
      console.error(`[Health] FATAL: ${snapshot.issues.join(', ')}`);
      if (!config.health.exitOnFatal || stopping) return;
      try {
        await stop('HEALTH_FATAL');
      } finally {
        process.exit(1);
      }
    },
  });
  runtimeHealth.start();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
