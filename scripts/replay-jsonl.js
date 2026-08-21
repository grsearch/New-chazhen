'use strict';

const fs = require('fs');
const readline = require('readline');
const { config, validateConfig } = require('../src/config');
const { SlotAssembler } = require('../src/core/SlotAssembler');
const { PostDumpRecoveryEngine } = require('../src/core/PostDumpRecoveryEngine');
const { ResearchStore } = require('../src/data/ResearchStore');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: pnpm replay <normalized-events.jsonl>');
  validateConfig({ requireStream: false });
  const store = new ResearchStore(config.storage);
  const slots = new SlotAssembler(config.slotAssembler);
  let replayNow = 0;
  const engine = new PostDumpRecoveryEngine({ config, store, now: () => replayNow || Date.now() });
  slots.on('slotFinalized', (summary) => store.recordSlotSummary(summary));
  const input = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let rows = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    replayNow = Number(event.receivedAtMs ?? event.timestampMs ?? replayNow);
    engine.observe(slots.ingest(event));
    engine.advanceTime(replayNow);
    rows += 1;
  }
  engine.advanceTime(replayNow + config.recovery.maxObservationMs + 1);
  const summary = store.summary();
  store.close();
  console.log(JSON.stringify({ replayedEvents: rows, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
