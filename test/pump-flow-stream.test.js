'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTransactionFilters, PumpFlowStream } = require('../src/core/PumpFlowStream');

const pumpProgramId = 'pump-program';
const ammProgramId = 'pumpswap-program';

function configuration(includePumpLifecycle) {
  return {
    pump: { programId: pumpProgramId, ammProgramId },
    stream: {
      includePumpLifecycle,
      endpoints: ['endpoint'],
      dedupTtlMs: 10_000,
      dedupMax: 1_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 30_000,
      staleTimeoutMs: 15_000,
      staleCheckMs: 2_000,
    },
  };
}

test('Helius-saving subscription keeps all PumpSwap traffic and omits Pump lifecycle', () => {
  const config = configuration(false);
  const filters = buildTransactionFilters(config, { create: (value) => value });
  assert.deepEqual(Object.keys(filters), ['pumpSwap']);
  assert.deepEqual(filters.pumpSwap.accountInclude, [ammProgramId]);

  const health = new PumpFlowStream({ config }).health();
  assert.equal(health.mode, 'ACTIVE_PASSIVE_PUMPSWAP_ONLY');
  assert.deepEqual(health.subscriptionFilters, ['pumpSwap']);
  assert.equal(health.exactMigrationTimestamps, false);
});

test('Pump lifecycle can be explicitly restored for exact migration timestamps', () => {
  const config = configuration(true);
  const filters = buildTransactionFilters(config, { create: (value) => value });
  assert.deepEqual(Object.keys(filters), ['pumpSwap', 'pumpLifecycle']);
  assert.deepEqual(filters.pumpLifecycle.accountInclude, [pumpProgramId]);

  const health = new PumpFlowStream({ config }).health();
  assert.equal(health.mode, 'ACTIVE_PASSIVE_PUMPSWAP_PLUS_PUMP_LIFECYCLE');
  assert.equal(health.exactMigrationTimestamps, true);
});
