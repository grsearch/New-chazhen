'use strict';

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

class RuntimeHealthMonitor {
  constructor({
    config,
    healthProvider,
    onFatal = () => {},
    logger = console,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.config = config;
    this.healthProvider = healthProvider;
    this.onFatal = onFatal;
    this.logger = logger;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.startedAtMs = null;
    this.lastCheckAtMs = null;
    this.lastHealthyAtMs = null;
    this.lastHealthyLogAtMs = null;
    this.lastStoreErrors = null;
    this.status = 'STOPPED';
    this.issues = [];
    this.metrics = {
      checks: 0,
      unhealthyChecks: 0,
      consecutiveUnhealthy: 0,
      providerErrors: 0,
      fatalTriggers: 0,
    };
    this.fatalTriggered = false;
  }

  start() {
    if (this.timer) return;
    this.startedAtMs = this.now();
    this.status = 'STARTING';
    this.check();
    this.timer = this.setIntervalFn(() => this.check(), this.config.checkIntervalMs);
    if (this.timer?.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.status = 'STOPPED';
  }

  check() {
    const now = this.now();
    if (this.startedAtMs == null) this.startedAtMs = now;
    this.lastCheckAtMs = now;
    this.metrics.checks += 1;

    let componentHealth;
    try {
      componentHealth = this.healthProvider();
    } catch (error) {
      this.metrics.providerErrors += 1;
      componentHealth = null;
      this.issues = [`HEALTH_PROVIDER_ERROR:${error.message}`];
    }
    if (componentHealth) this.issues = this._evaluate(componentHealth, now);

    const graceElapsed = now - this.startedAtMs >= this.config.startupGraceMs;
    if (!graceElapsed) {
      this.status = 'STARTING';
      this.metrics.consecutiveUnhealthy = 0;
    } else if (this.issues.length) {
      this.status = 'DEGRADED';
      this.metrics.unhealthyChecks += 1;
      this.metrics.consecutiveUnhealthy += 1;
      this.logger.warn?.(
        `[Health] DEGRADED ${this.metrics.consecutiveUnhealthy}/${this.config.fatalConsecutiveChecks}: ${this.issues.join(', ')}`,
      );
    } else {
      this.status = 'HEALTHY';
      this.lastHealthyAtMs = now;
      this.metrics.consecutiveUnhealthy = 0;
      if (this.lastHealthyLogAtMs == null
        || now - this.lastHealthyLogAtMs >= this.config.healthyLogIntervalMs) {
        const stream = componentHealth.stream || {};
        const engine = componentHealth.engine || {};
        this.logger.info?.(
          `[Health] OK stream=${stream.state || 'UNKNOWN'} events=${engine.events || 0} errors=${engine.errors || 0}`,
        );
        this.lastHealthyLogAtMs = now;
      }
    }

    if (!this.fatalTriggered
      && this.metrics.consecutiveUnhealthy >= this.config.fatalConsecutiveChecks) {
      this.fatalTriggered = true;
      this.metrics.fatalTriggers += 1;
      const snapshot = this.health();
      try {
        Promise.resolve(this.onFatal(snapshot)).catch((error) => {
          this.logger.error?.(`[Health] fatal handler failed: ${error.message}`);
        });
      } catch (error) {
        this.logger.error?.(`[Health] fatal handler failed: ${error.message}`);
      }
    }
    return this.health();
  }

  _evaluate(health, now) {
    const issues = [];
    const stream = health.stream || {};
    const store = health.store || {};
    if (stream.state !== 'CONNECTED') issues.push(`STREAM_${stream.state || 'UNKNOWN'}`);

    const streamAnchor = finite(stream.lastMessageAtMs, finite(stream.connectedAtMs));
    if (streamAnchor == null) issues.push('STREAM_NO_ACTIVITY_TIMESTAMP');
    else if (now - streamAnchor > this.config.maxEventStaleMs) {
      issues.push(`STREAM_STALE_${Math.max(0, now - streamAnchor)}MS`);
    }

    const pendingWrites = finite(store.pendingWrites, 0);
    if (pendingWrites > this.config.maxPendingWrites) {
      issues.push(`DB_PENDING_WRITES_${pendingWrites}`);
    }
    const storeErrors = finite(store.errors, 0);
    if (this.lastStoreErrors != null && storeErrors > this.lastStoreErrors) {
      issues.push(`DB_WRITE_ERRORS_INCREASED_${storeErrors - this.lastStoreErrors}`);
    }
    this.lastStoreErrors = storeErrors;
    return issues;
  }

  health() {
    return {
      enabled: true,
      status: this.status,
      startedAtMs: this.startedAtMs,
      lastCheckAtMs: this.lastCheckAtMs,
      lastHealthyAtMs: this.lastHealthyAtMs,
      issues: [...this.issues],
      fatalTriggered: this.fatalTriggered,
      checkIntervalMs: this.config.checkIntervalMs,
      maxEventStaleMs: this.config.maxEventStaleMs,
      maxPendingWrites: this.config.maxPendingWrites,
      fatalConsecutiveChecks: this.config.fatalConsecutiveChecks,
      ...this.metrics,
    };
  }
}

module.exports = { RuntimeHealthMonitor };
