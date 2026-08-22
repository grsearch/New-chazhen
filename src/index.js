'use strict';

const { config, validateConfig } = require('./config');
const { PumpEventParser } = require('./core/PumpEventParser');
const { PumpFlowStream } = require('./core/PumpFlowStream');
const { SlotAssembler } = require('./core/SlotAssembler');
const { PostDumpRecoveryEngine } = require('./core/PostDumpRecoveryEngine');
const { ResearchStore } = require('./data/ResearchStore');
const { DashboardServer } = require('./server/DashboardServer');
const { RuntimeHealthMonitor } = require('./core/RuntimeHealthMonitor');

async function main() {
  validateConfig({ requireStream: true });
  const store = new ResearchStore(config.storage);
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
  let streamState = { state: 'STARTING' };
  let runtimeHealth = null;
  slots.on('slotFinalized', (summary) => store.recordSlotSummary(summary));
  stream.on('state', (state) => { streamState = state; });
  stream.on('streamError', ({ error, phase, retryInMs }) => {
    console.error(`[LaserStream:${phase}] ${error.message}; retry in ${retryInMs}ms`);
  });
  stream.on('transaction', (transaction, context) => {
    try {
      for (const parsed of parser.parseTransaction(transaction, context.receivedAtMs)) {
        engine.observe(slots.ingest(parsed));
      }
    } catch (error) {
      engine.metrics.errors += 1;
      console.error('[ingestion]', error.message);
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
  await stream.start();
  runtimeHealth = new RuntimeHealthMonitor({
    config: config.health,
    healthProvider: componentHealth,
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
