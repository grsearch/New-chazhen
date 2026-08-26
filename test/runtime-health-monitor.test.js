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
    minDiskFreeBytes: 10 * 1024 ** 3,
    minDiskFreePct: 10,
    minimumJoinSamples: 100,
    minimumJoinRatePct: 90,
    recoverableConsecutiveChecks: 2,
    recoveryCooldownMs: 120_000,
    recoveryBackoffMultiplier: 2,
    recoveryMaxCooldownMs: 900_000,
    recoveryMaxAttempts: 3,
    recoveryResetHealthyMs: 300_000,
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

test('low disk space is detected locally before the filesystem is full', () => {
  const now = 4_000_000;
  const state = healthy(now);
  state.store.diskFreeBytes = 5 * 1024 ** 3;
  state.store.diskFreePct = 8;
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => state,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  const result = monitor.check();
  assert.equal(result.status, 'DEGRADED');
  assert.match(result.issues[0], /^DISK_LOW_5\.00GB_8\.00PCT$/);
});

test('lightweight ingestion detects sustained log and status join loss', () => {
  const now = 5_000_000;
  const state = healthy(now);
  Object.assign(state.stream, {
    receivesFullTransactionMetadata: false,
    logStatusJoinMatureSamples: 1_000,
    logStatusJoinRatePct: 50,
  });
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => ({
      ...state,
      stream: {
        ...state.stream,
        connectedAtMs: now - 10_000,
        lastMessageAtMs: now - 100,
        lastLogAtMs: now - 100,
        lastStatusAtMs: now - 100,
      },
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  const result = monitor.check();
  assert.equal(result.status, 'DEGRADED');
  assert.deepEqual(result.issues, ['LIGHTWEIGHT_JOIN_RATE_LOW_50.00PCT']);
  assert.deepEqual(result.recoverableIssues, ['LIGHTWEIGHT_JOIN_RATE_LOW_50.00PCT']);
  assert.deepEqual(result.fatalIssues, []);
  assert.equal(result.fatalTriggered, false);
});

test('low join quality requests a targeted recovery and never becomes process-fatal', async () => {
  let now = 5_500_000;
  let recoveries = 0;
  let fatals = 0;
  const state = healthy(now);
  Object.assign(state.stream, {
    receivesFullTransactionMetadata: false,
    logStatusJoinMatureSamples: 1_000,
    logStatusJoinRatePct: 5,
  });
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => ({
      ...state,
      stream: {
        ...state.stream,
        connectedAtMs: now - 10_000,
        lastMessageAtMs: now - 100,
        lastLogAtMs: now - 100,
        lastStatusAtMs: now - 100,
      },
    }),
    onRecoverable: () => { recoveries += 1; },
    onFatal: () => { fatals += 1; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  monitor.check();
  now += 60_000;
  monitor.check();
  await Promise.resolve();
  assert.equal(recoveries, 1);
  assert.equal(fatals, 0);
  assert.equal(monitor.health().recoveryTriggers, 1);
  for (let index = 0; index < 4; index += 1) {
    now += 60_000;
    monitor.check();
  }
  await Promise.resolve();
  assert.equal(fatals, 0, 'recoverable join loss must not request a systemd restart');
  assert.equal(monitor.health().fatalTriggered, false);
});

test('repeated join recoveries back off, pause, and reset only after stable health', async () => {
  let now = 5_800_000;
  let degraded = true;
  let recoveries = 0;
  const monitor = new RuntimeHealthMonitor({
    config: configuration({
      recoverableConsecutiveChecks: 2,
      recoveryCooldownMs: 1_000,
      recoveryBackoffMultiplier: 2,
      recoveryMaxCooldownMs: 8_000,
      recoveryMaxAttempts: 3,
      recoveryResetHealthyMs: 60_000,
    }),
    healthProvider: () => {
      const state = healthy(now);
      if (degraded) Object.assign(state.stream, {
        receivesFullTransactionMetadata: false,
        logStatusJoinMatureSamples: 1_000,
        logStatusJoinRatePct: 5,
        lastLogAtMs: now - 100,
        lastStatusAtMs: now - 100,
      });
      return state;
    },
    onRecoverable: () => { recoveries += 1; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });

  monitor.check();
  monitor.check();
  await Promise.resolve();
  assert.equal(recoveries, 1);
  assert.equal(monitor.health().effectiveRecoveryCooldownMs, 2_000);

  now += 1_999;
  monitor.check();
  monitor.check();
  assert.equal(recoveries, 1, 'second recovery waits for exponential backoff');
  now += 1;
  monitor.check();
  await Promise.resolve();
  assert.equal(recoveries, 2);

  now += 4_000;
  monitor.check();
  monitor.check();
  await Promise.resolve();
  assert.equal(recoveries, 3);
  assert.equal(monitor.health().recoverySuppressed, true);
  assert.equal(monitor.health().recoverySuppressions, 1);

  now += 60_000;
  monitor.check();
  assert.equal(recoveries, 3, 'suppression prevents an endless reconnect loop');

  degraded = false;
  monitor.check();
  now += 60_000;
  monitor.check();
  assert.equal(monitor.health().recoverySuppressed, false);
  assert.equal(monitor.health().recoveryAttemptsSinceHealthy, 0);

  degraded = true;
  monitor.check();
  monitor.check();
  await Promise.resolve();
  assert.equal(recoveries, 4, 'stable health re-arms controlled recovery');
});

test('lightweight ingestion detects one-sided stream silence', () => {
  const now = 6_000_000;
  const state = healthy(now);
  Object.assign(state.stream, {
    receivesFullTransactionMetadata: false,
    lastLogAtMs: now - 200_000,
    lastStatusAtMs: now - 100,
  });
  const monitor = new RuntimeHealthMonitor({
    config: configuration(),
    healthProvider: () => state,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  });
  assert.deepEqual(monitor.check().issues, ['LOG_STREAM_STALE_200000MS']);
});
