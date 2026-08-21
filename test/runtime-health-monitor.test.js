'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeHealthMonitor } = require('../src/core/RuntimeHealthMonitor');

function configuration(overrides = {}) {
  return {
    checkIntervalMs: 60_000,
    healthyLogIntervalMs: 600_000,
    startupGraceMs: 0,
    maxEventStaleMs: 120_000,
    maxPendingWrites: 5_000,
    fatalConsecutiveChecks: 3,
    ...overrides,
  };
}

function healthy(at) {
  return {
    stream: { state: 'CONNECTED', connectedAtMs: at - 10_000, lastMessageAtMs: at - 100 },
    engine: { events: 100, errors: 0 },
    store: { pendingWrites: 0, errors: 0 },
  };
}

test('runtime health monitor reports healthy components without external polling', () => {
  let now = 1_000_000;
  const logs = [];
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => healthy(now),
    logger: { info: (message) => logs.push(message), warn: () => {}, error: () => {} },
    now: () => now,
  });
  const result = monitor.check();
  assert.equal(result.status, 'HEALTHY');
  assert.equal(result.consecutiveUnhealthy, 0);
  assert.deepEqual(result.issues, []);
  assert.equal(logs.length, 1);
  now += 60_000;
  monitor.check();
  assert.equal(logs.length, 1, 'healthy logging is rate-limited and does not poll an AI service');
});

test('a new connection uses connected time until its first stream message', () => {
  const now = 1_500_000;
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => ({
      stream: { state: 'CONNECTED', connectedAtMs: now - 1_000, lastMessageAtMs: null },
      engine: { events: 0, errors: 0 },
      store: { pendingWrites: 0, errors: 0 },
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  const result = monitor.check();
  assert.equal(result.status, 'HEALTHY');
  assert.deepEqual(result.issues, []);
});

test('sustained stream failure triggers one systemd restart request', async () => {
  const now = 2_000_000;
  let fatals = 0;
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => ({
      stream: { state: 'RECONNECTING', connectedAtMs: now - 500_000, lastMessageAtMs: now - 500_000 },
      engine: { events: 0, errors: 0 },
      store: { pendingWrites: 0, errors: 0 },
    }),
    onFatal: () => { fatals += 1; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  monitor.check();
  monitor.check();
  const result = monitor.check();
  await Promise.resolve();
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.consecutiveUnhealthy, 3);
  assert.equal(result.fatalTriggered, true);
  assert.equal(fatals, 1);
  monitor.check();
  await Promise.resolve();
  assert.equal(fatals, 1, 'fatal callback must not create a restart loop');
});

test('a recovered component resets the consecutive failure counter', () => {
  const now = 3_000_000;
  let current = {
    stream: { state: 'CONNECTED', connectedAtMs: now - 500_000, lastMessageAtMs: now - 500_000 },
    engine: { events: 0, errors: 0 },
    store: { pendingWrites: 6_000, errors: 0 },
  };
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => current,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  assert.equal(monitor.check().consecutiveUnhealthy, 1);
  current = healthy(now);
  const recovered = monitor.check();
  assert.equal(recovered.status, 'HEALTHY');
  assert.equal(recovered.consecutiveUnhealthy, 0);
});
