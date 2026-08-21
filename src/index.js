'use strict';

const { config, validateConfig } = require('./config');
const { PumpEventParser } = require('./core/PumpEventParser');
const { PumpFlowStream } = require('./core/PumpFlowStream');
const { SlotAssembler } = require('./core/SlotAssembler');
const { PostDumpRecoveryEngine } = require('./core/PostDumpRecoveryEngine');
const { ResearchStore } = require('./data/ResearchStore');
const { DashboardServer } = require('./server/DashboardServer');

async function main() {
  validateConfig({ requireStream: true });
  const store = new ResearchStore(config.storage);
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

  const dashboard = new DashboardServer({
    config: config.dashboard,
    store,
    health: () => ({
      generatedAtMs: Date.now(),
      stream: streamState,
      slotAssembler: slots.health(),
      engine: engine.health(),
      store: store.health(),
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
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
