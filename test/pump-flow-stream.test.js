'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bs58Module = require('bs58');
const {
  buildTransactionFilters, buildTransactionStatusFilters, PumpFlowStream,
} = require('../src/core/PumpFlowStream');

const bs58 = bs58Module.default || bs58Module;

const pumpProgramId = 'pump-program';
const ammProgramId = 'pumpswap-program';

function configuration(includePumpLifecycle) {
  return {
    pump: { programId: pumpProgramId, ammProgramId },
    stream: {
      mode: 'full-transactions',
      includePumpLifecycle,
      endpoints: ['endpoint'],
      joinTtlMs: 10_000,
      joinQualityWindowMs: 300_000,
      joinQualityBucketMs: 1_000,
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

test('lightweight mode joins PumpSwap logs with tiny transaction status ordering', () => {
  let now = 1_000;
  const config = configuration(false);
  config.stream.mode = 'logs-status';
  const filters = buildTransactionStatusFilters(config, { create: (value) => value });
  assert.deepEqual(Object.keys(filters), ['pumpSwapStatus']);
  assert.deepEqual(filters.pumpSwapStatus.accountInclude, [ammProgramId]);

  const stream = new PumpFlowStream({ config, now: () => now });
  const joined = [];
  stream.on('logTransaction', (transaction, context) => joined.push({ transaction, context }));
  const signatureBytes = Buffer.alloc(64, 7);
  const signature = bs58.encode(signatureBytes);
  stream._onLogNotification({ signature, err: null, logs: ['Program log: test'] }, { slot: 42 });
  stream._onTransactionStatus({ signature: signatureBytes, slot: 42, index: 9, err: null }, now);

  assert.equal(joined.length, 1);
  assert.equal(joined[0].transaction.signature, signature);
  assert.equal(joined[0].transaction.transactionIndex, 9);
  assert.equal(stream.health().mode, 'LIGHTWEIGHT_PUMPSWAP_LOGS_PLUS_STATUS');
  assert.equal(stream.health().receivesFullTransactionMetadata, false);
  assert.equal(stream.health().logStatusJoinRatePct, null, 'unmatured joins are excluded');
  now += config.stream.joinTtlMs + config.stream.joinQualityBucketMs;
  assert.equal(stream.health().logStatusJoinRatePct, 100);
  assert.equal(stream.health().logStatusJoinMatureSamples, 1);
  assert.equal(stream.health().pendingLogStatusJoins, 0);
});

test('lightweight join health uses mature rolling outcomes instead of lifetime counters', () => {
  let now = 10_000;
  const config = configuration(false);
  config.stream.mode = 'logs-status';
  const stream = new PumpFlowStream({ config, now: () => now });
  for (let index = 0; index < 9; index += 1) {
    const signature = `matched-${index}`;
    stream._onLogNotification({ signature, err: null, logs: ['Program log: test'] }, { slot: 42 });
    stream._onTransactionStatus({ signature, slot: 42, index, err: null }, now);
  }
  stream._onLogNotification(
    { signature: 'log-only', err: null, logs: ['Program log: test'] }, { slot: 42 },
  );
  stream._onTransactionStatus({ signature: 'status-only', slot: 42, index: 10, err: null }, now);

  assert.equal(stream.health().logStatusJoinRatePct, null);
  now += config.stream.joinTtlMs + config.stream.joinQualityBucketMs;
  const degraded = stream.health();
  assert.equal(degraded.logStatusJoinMatureSamples, 10);
  assert.equal(degraded.logStatusJoinRatePct, 90);
  assert.equal(degraded.logStatusLogCoveragePct, 90);
  assert.equal(degraded.logStatusStatusCoveragePct, 90);

  stream._resetJoinQuality(now);
  assert.equal(stream.health().logStatusJoinMatureSamples, 0);
  assert.equal(stream.metrics.matchedLightweightPairs, 9, 'lifetime diagnostics remain intact');
});

test('controlled quality recovery reconnects without incrementing stream errors', () => {
  const config = configuration(false);
  config.stream.mode = 'logs-status';
  const stream = new PumpFlowStream({ config });
  stream.running = true;
  assert.equal(stream.requestReconnect('TEST_JOIN_RECOVERY'), true);
  assert.equal(stream.metrics.qualityReconnects, 1);
  assert.equal(stream.metrics.errors, 0);
  assert.equal(stream.requestReconnect('DUPLICATE_RECOVERY'), false);
  clearTimeout(stream.reconnectTimer);
  stream.reconnectTimer = null;
  stream.running = false;
});

test('one-sided mature join loss reaches the health sample threshold', () => {
  let now = 20_000;
  const config = configuration(false);
  config.stream.mode = 'logs-status';
  const stream = new PumpFlowStream({ config, now: () => now });
  for (let index = 0; index < 100; index += 1) {
    stream._onLogNotification(
      { signature: `missing-status-${index}`, err: null, logs: ['Program log: test'] },
      { slot: 42 },
    );
  }
  now += config.stream.joinTtlMs + config.stream.joinQualityBucketMs;
  const health = stream.health();
  assert.equal(health.logStatusJoinMatureSamples, 100);
  assert.equal(health.logStatusJoinRatePct, null);
  assert.equal(health.logStatusLogCoveragePct, 0);
  assert.equal(health.logStatusStatusCoveragePct, null);
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
