'use strict';

const EventEmitter = require('events');
const bs58Module = require('bs58');
const { Connection, PublicKey } = require('@solana/web3.js');
const { extractSignature } = require('./PumpEventParser');

const bs58 = bs58Module.default || bs58Module;

let runtime = null;

function yellowstone() {
  if (runtime) return runtime;
  let module;
  try {
    module = require('@triton-one/yellowstone-grpc');
  } catch (error) {
    if (process.platform === 'win32') {
      throw new Error('Yellowstone gRPC collector must run on Linux or WSL2', { cause: error });
    }
    throw error;
  }
  runtime = {
    Client: module.default,
    CommitmentLevel: module.CommitmentLevel,
    SubscribeRequest: module.SubscribeRequest,
    SubscribeRequestFilterTransactions: module.SubscribeRequestFilterTransactions,
  };
  return runtime;
}

function proto(type, value) {
  return type?.create ? type.create(value) : value;
}

function buildTransactionFilters(config, filterType) {
  const filter = (programId) => proto(filterType, {
    vote: false,
    failed: false,
    accountInclude: [programId],
    accountExclude: [],
    accountRequired: [],
  });
  const transactions = {
    pumpSwap: filter(config.pump.ammProgramId),
  };
  if (config.stream.includePumpLifecycle) {
    transactions.pumpLifecycle = filter(config.pump.programId);
  }
  return transactions;
}

function buildTransactionStatusFilters(config, filterType) {
  return {
    pumpSwapStatus: proto(filterType, {
      vote: false,
      failed: false,
      accountInclude: [config.pump.ammProgramId],
      accountExclude: [],
      accountRequired: [],
    }),
  };
}

function signatureText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return bs58.encode(Buffer.from(value));
  }
  return null;
}

function nonnegativeInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

class PumpFlowStream extends EventEmitter {
  constructor({
    config, connectionFactory = null, logsConnectionFactory = null,
    now = () => Date.now(),
  }) {
    super();
    this.config = config;
    this.connectionFactory = connectionFactory;
    this.logsConnectionFactory = logsConnectionFactory;
    this.now = now;
    this.running = false;
    this.client = null;
    this.stream = null;
    this.logsConnection = null;
    this.logsSubscriptionId = null;
    this.endpointIndex = -1;
    this.retry = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.lastMessageAtMs = null;
    this.lastLogAtMs = null;
    this.lastStatusAtMs = null;
    this.connectedAtMs = null;
    this.seen = new Map();
    this.pendingLogs = new Map();
    this.pendingStatuses = new Map();
    this.joinQualityBuckets = new Map();
    this.joinQualityStartedAtMs = this.now();
    this.metrics = {
      received: 0,
      fullTransactions: 0,
      logNotifications: 0,
      transactionStatuses: 0,
      joinedLightweightTransactions: 0,
      matchedLightweightPairs: 0,
      unmatchedLogsExpired: 0,
      unmatchedStatusesExpired: 0,
      slotMismatches: 0,
      approximateLogBytes: 0,
      approximateStatusBytes: 0,
      duplicates: 0,
      reconnects: 0,
      qualityReconnects: 0,
      errors: 0,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._startWatchdog();
    await this._connect(0, 'STARTUP');
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnectTimer = null;
    this.watchdog = null;
    await this._close();
  }

  async _connect(index, reason) {
    if (!this.running) return;
    await this._close();
    this._resetJoinQuality(this.now());
    this.endpointIndex = index % this.config.stream.endpoints.length;
    const endpoint = this.config.stream.endpoints[this.endpointIndex];
    this.emit('state', this.health({ state: 'CONNECTING', reason }));
    try {
      const connection = this.connectionFactory
        ? await this.connectionFactory({ endpoint, token: this.config.stream.token })
        : await this._yellowstoneConnection(endpoint);
      this.client = connection.client;
      this.stream = connection.stream;
      this.stream.on('data', (message) => this._onMessage(message));
      this.stream.on('error', (error) => this._unavailable(error, 'STREAM_ERROR'));
      this.stream.on('end', () => this._unavailable(new Error('stream ended'), 'STREAM_END'));
      this.stream.on('close', () => this._unavailable(new Error('stream closed'), 'STREAM_CLOSE'));
      this.connectedAtMs = this.now();
      this.lastMessageAtMs = null;
      this.lastLogAtMs = null;
      this.lastStatusAtMs = null;
      if (this._isLightweight()) await this._startLogStream();
      this.retry = 0;
      this.emit('state', this.health({ state: 'CONNECTED', reason }));
    } catch (error) {
      this._unavailable(error, 'CONNECT_ERROR');
    }
  }

  async _yellowstoneConnection(endpoint) {
    const types = yellowstone();
    const client = new types.Client(endpoint, this.config.stream.token, {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 5_000,
      'grpc.keepalive_permit_without_calls': 1,
    });
    if (typeof client.connect === 'function') await client.connect();
    const stream = await client.subscribe();
    const lightweight = this._isLightweight();
    const request = proto(types.SubscribeRequest, {
      transactions: lightweight ? {} : buildTransactionFilters(
        this.config, types.SubscribeRequestFilterTransactions,
      ),
      accounts: {}, slots: {}, blocks: {}, blocksMeta: {}, entry: {},
      transactionsStatus: lightweight ? buildTransactionStatusFilters(
        this.config, types.SubscribeRequestFilterTransactions,
      ) : {},
      accountsDataSlice: [],
      commitment: types.CommitmentLevel.PROCESSED,
    });
    await new Promise((resolve, reject) => {
      stream.write(request, (error) => (error ? reject(error) : resolve()));
    });
    return { client, stream };
  }

  _onMessage(message) {
    const receivedAtMs = this.now();
    this.lastMessageAtMs = receivedAtMs;
    if (this._isLightweight()) {
      const status = message?.transactionStatus || message?.transaction_status;
      if (status) this._onTransactionStatus(status, receivedAtMs);
      return;
    }
    if (!message?.transaction) return;
    const signature = extractSignature(message.transaction);
    if (signature && !this._first(signature, receivedAtMs)) {
      this.metrics.duplicates += 1;
      return;
    }
    this.metrics.received += 1;
    this.metrics.fullTransactions += 1;
    this.emit('transaction', message.transaction, { receivedAtMs, endpointIndex: this.endpointIndex });
  }

  _isLightweight() {
    return this.config.stream.mode === 'logs-status';
  }

  async _startLogStream() {
    this.logsConnection = this.logsConnectionFactory
      ? await this.logsConnectionFactory({
        rpcUrl: this.config.stream.rpcUrl,
        programId: this.config.pump.ammProgramId,
      })
      : new Connection(this.config.stream.rpcUrl, {
        commitment: 'processed',
        disableRetryOnRateLimit: false,
      });
    this.logsSubscriptionId = await this.logsConnection.onLogs(
      new PublicKey(this.config.pump.ammProgramId),
      (value, context) => this._onLogNotification(value, context),
      'processed',
    );
  }

  _onLogNotification(value, context = {}) {
    const receivedAtMs = this.now();
    this.lastMessageAtMs = receivedAtMs;
    this.lastLogAtMs = receivedAtMs;
    if (!value || value.err || !value.signature || !Array.isArray(value.logs)) return;
    this.metrics.logNotifications += 1;
    try {
      this.metrics.approximateLogBytes += Buffer.byteLength(JSON.stringify(value));
    } catch (_) {}
    this.pendingLogs.set(value.signature, {
      signature: value.signature,
      slot: nonnegativeInteger(context.slot),
      logs: value.logs,
      err: value.err,
      receivedAtMs,
      expiresAtMs: receivedAtMs + this.config.stream.joinTtlMs,
    });
    this._joinLightweight(value.signature, receivedAtMs);
  }

  _onTransactionStatus(status, receivedAtMs) {
    const signature = signatureText(status.signature);
    if (!signature || status.err) return;
    this.lastStatusAtMs = receivedAtMs;
    this.metrics.transactionStatuses += 1;
    this.metrics.approximateStatusBytes += 96;
    this.pendingStatuses.set(signature, {
      signature,
      slot: nonnegativeInteger(status.slot),
      transactionIndex: nonnegativeInteger(status.index),
      receivedAtMs,
      expiresAtMs: receivedAtMs + this.config.stream.joinTtlMs,
    });
    this._joinLightweight(signature, receivedAtMs);
  }

  _joinLightweight(signature, now) {
    const logs = this.pendingLogs.get(signature);
    const status = this.pendingStatuses.get(signature);
    if (!logs || !status) {
      this._expirePairs(now);
      return;
    }
    this.pendingLogs.delete(signature);
    this.pendingStatuses.delete(signature);
    const outcomeAtMs = Math.min(logs.receivedAtMs, status.receivedAtMs);
    if (logs.slot != null && status.slot != null && logs.slot !== status.slot) {
      this.metrics.slotMismatches += 1;
      this._recordJoinOutcome('slotMismatches', outcomeAtMs);
      this._expirePairs(now);
      return;
    }
    this.metrics.matchedLightweightPairs += 1;
    this._recordJoinOutcome('joined', outcomeAtMs);
    if (!this._first(signature, now)) {
      this.metrics.duplicates += 1;
      return;
    }
    this.metrics.received += 1;
    this.metrics.joinedLightweightTransactions += 1;
    this.emit('logTransaction', {
      signature,
      slot: status.slot ?? logs.slot,
      transactionIndex: status.transactionIndex,
      logs: logs.logs,
      err: null,
    }, {
      receivedAtMs: logs.receivedAtMs,
      statusReceivedAtMs: status.receivedAtMs,
      joinedAtMs: now,
      endpointIndex: this.endpointIndex,
    });
    this._expirePairs(now);
  }

  _expirePairs(now) {
    const limit = Math.max(this.config.stream.dedupMax, 1_000);
    for (const [signature, row] of this.pendingLogs) {
      if (row.expiresAtMs > now && this.pendingLogs.size <= limit) continue;
      this.pendingLogs.delete(signature);
      this.metrics.unmatchedLogsExpired += 1;
      this._recordJoinOutcome('unmatchedLogs', row.receivedAtMs);
    }
    for (const [signature, row] of this.pendingStatuses) {
      if (row.expiresAtMs > now && this.pendingStatuses.size <= limit) continue;
      this.pendingStatuses.delete(signature);
      this.metrics.unmatchedStatusesExpired += 1;
      this._recordJoinOutcome('unmatchedStatuses', row.receivedAtMs);
    }
    this._pruneJoinQuality(now);
  }

  _joinTtlMs() {
    return Math.max(1_000, Number(this.config.stream.joinTtlMs) || 30_000);
  }

  _joinQualityWindowMs() {
    return Math.max(60_000, Number(this.config.stream.joinQualityWindowMs) || 300_000);
  }

  _joinQualityBucketMs() {
    return Math.max(250, Number(this.config.stream.joinQualityBucketMs) || 1_000);
  }

  _resetJoinQuality(now) {
    this.joinQualityBuckets.clear();
    this.joinQualityStartedAtMs = now;
  }

  _recordJoinOutcome(kind, atMs) {
    const bucketMs = this._joinQualityBucketMs();
    const bucketAtMs = Math.floor(atMs / bucketMs) * bucketMs;
    const bucket = this.joinQualityBuckets.get(bucketAtMs) || {
      joined: 0,
      unmatchedLogs: 0,
      unmatchedStatuses: 0,
      slotMismatches: 0,
    };
    bucket[kind] += 1;
    this.joinQualityBuckets.set(bucketAtMs, bucket);
  }

  _pruneJoinQuality(now) {
    const keepAfter = now - this._joinQualityWindowMs()
      - this._joinTtlMs() - this._joinQualityBucketMs();
    for (const bucketAtMs of this.joinQualityBuckets.keys()) {
      if (bucketAtMs < keepAfter) this.joinQualityBuckets.delete(bucketAtMs);
    }
  }

  _joinQuality(now) {
    this._pruneJoinQuality(now);
    const ttlMs = this._joinTtlMs();
    const windowMs = this._joinQualityWindowMs();
    const bucketMs = this._joinQualityBucketMs();
    const matureBeforeMs = now - ttlMs;
    const windowStartMs = Math.max(
      this.joinQualityStartedAtMs ?? -Infinity,
      matureBeforeMs - windowMs,
    );
    const totals = {
      joined: 0, unmatchedLogs: 0, unmatchedStatuses: 0, slotMismatches: 0,
    };
    for (const [bucketAtMs, bucket] of this.joinQualityBuckets) {
      if (bucketAtMs < windowStartMs || bucketAtMs + bucketMs > matureBeforeMs) continue;
      for (const key of Object.keys(totals)) totals[key] += bucket[key] || 0;
    }
    const logSamples = totals.joined + totals.unmatchedLogs + totals.slotMismatches;
    const statusSamples = totals.joined + totals.unmatchedStatuses + totals.slotMismatches;
    const logRatePct = logSamples > 0 ? totals.joined / logSamples * 100 : null;
    const statusRatePct = statusSamples > 0 ? totals.joined / statusSamples * 100 : null;
    const ratePct = logRatePct == null || statusRatePct == null
      ? null : Math.min(logRatePct, statusRatePct);
    return {
      ratePct,
      matureSamples: Math.max(logSamples, statusSamples),
      logRatePct,
      statusRatePct,
      logSamples,
      statusSamples,
      windowMs,
      ttlMs,
      matureBeforeMs,
      ...totals,
    };
  }

  _first(signature, now) {
    const expiry = this.seen.get(signature);
    if (expiry > now) return false;
    this.seen.set(signature, now + this.config.stream.dedupTtlMs);
    if (this.seen.size > this.config.stream.dedupMax) {
      for (const [key, expiresAt] of this.seen) {
        if (expiresAt <= now || this.seen.size > this.config.stream.dedupMax * 0.9) this.seen.delete(key);
        if (this.seen.size <= this.config.stream.dedupMax * 0.9) break;
      }
    }
    return true;
  }

  _unavailable(error, phase, { countError = true } = {}) {
    if (!this.running || this.reconnectTimer) return false;
    if (countError) this.metrics.errors += 1;
    this.retry += 1;
    const delay = Math.min(
      this.config.stream.reconnectMaxMs,
      this.config.stream.reconnectMinMs * (2 ** Math.min(8, this.retry - 1)),
    );
    const next = (this.endpointIndex + 1) % this.config.stream.endpoints.length;
    this.emit('streamError', { error, phase, retryInMs: delay });
    this.emit('state', this.health({ state: 'RECONNECTING', phase, retryInMs: delay }));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.metrics.reconnects += 1;
      this._connect(next, phase).catch((connectError) => this._unavailable(connectError, 'RECONNECT_ERROR'));
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    return true;
  }

  requestReconnect(reason = 'QUALITY_RECOVERY') {
    const scheduled = this._unavailable(
      new Error(`controlled stream recovery requested: ${reason}`),
      reason,
      { countError: false },
    );
    if (scheduled) this.metrics.qualityReconnects += 1;
    return scheduled;
  }

  _startWatchdog() {
    this.watchdog = setInterval(() => {
      if (!this.running || !this.connectedAtMs || this.reconnectTimer) return;
      const now = this.now();
      if (this._isLightweight()) {
        this._expirePairs(now);
        const logAnchor = this.lastLogAtMs || this.connectedAtMs;
        const statusAnchor = this.lastStatusAtMs || this.connectedAtMs;
        if (now - logAnchor >= this.config.stream.staleTimeoutMs) {
          this._unavailable(new Error('PumpSwap log stream became stale'), 'LOG_STREAM_STALE');
        } else if (now - statusAnchor >= this.config.stream.staleTimeoutMs) {
          this._unavailable(
            new Error('PumpSwap transaction status stream became stale'),
            'STATUS_STREAM_STALE',
          );
        }
        return;
      }
      const last = this.lastMessageAtMs || this.connectedAtMs;
      if (now - last >= this.config.stream.staleTimeoutMs) {
        this._unavailable(new Error('LaserStream became stale'), 'STALE');
      }
    }, this.config.stream.staleCheckMs);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  async _close() {
    if (this.logsConnection && this.logsSubscriptionId != null) {
      try { await this.logsConnection.removeOnLogsListener(this.logsSubscriptionId); } catch (_) {}
    }
    this.logsSubscriptionId = null;
    this.logsConnection = null;
    this.pendingLogs.clear();
    this.pendingStatuses.clear();
    if (this.stream) {
      try { this.stream.removeAllListeners(); } catch (_) {}
      try { this.stream.destroy(); } catch (_) {}
      this.stream = null;
    }
    if (this.client) {
      try { this.client.close?.(); } catch (_) {}
      this.client = null;
    }
  }

  health(extra = {}) {
    const includesPumpLifecycle = Boolean(this.config.stream.includePumpLifecycle);
    const lightweight = this._isLightweight();
    const now = this.now();
    if (lightweight) this._expirePairs(now);
    const joinQuality = lightweight ? this._joinQuality(now) : null;
    return {
      mode: lightweight
        ? 'LIGHTWEIGHT_PUMPSWAP_LOGS_PLUS_STATUS'
        : includesPumpLifecycle
        ? 'ACTIVE_PASSIVE_PUMPSWAP_PLUS_PUMP_LIFECYCLE'
        : 'ACTIVE_PASSIVE_PUMPSWAP_ONLY',
      subscriptionFilters: lightweight
        ? ['pumpSwapLogs', 'pumpSwapStatus']
        : includesPumpLifecycle
        ? ['pumpSwap', 'pumpLifecycle'] : ['pumpSwap'],
      exactMigrationTimestamps: !lightweight && includesPumpLifecycle,
      receivesFullTransactionMetadata: !lightweight,
      pendingLogStatusJoins: this.pendingLogs.size + this.pendingStatuses.size,
      logStatusJoinRatePct: joinQuality?.ratePct ?? null,
      logStatusJoinMatureSamples: joinQuality?.matureSamples || 0,
      logStatusLogCoveragePct: joinQuality?.logRatePct ?? null,
      logStatusStatusCoveragePct: joinQuality?.statusRatePct ?? null,
      logStatusLogMatureSamples: joinQuality?.logSamples || 0,
      logStatusStatusMatureSamples: joinQuality?.statusSamples || 0,
      logStatusJoinWindowMs: joinQuality?.windowMs || null,
      logStatusJoinTtlMs: joinQuality?.ttlMs || null,
      joinQualityStartedAtMs: this.joinQualityStartedAtMs,
      approximateLogMegabytes: this.metrics.approximateLogBytes / 1_000_000,
      approximatePayloadMegabytes:
        (this.metrics.approximateLogBytes + this.metrics.approximateStatusBytes) / 1_000_000,
      endpointIndex: this.endpointIndex,
      endpoint: this.endpointIndex >= 0 ? this.config.stream.endpoints[this.endpointIndex] : null,
      connectedAtMs: this.connectedAtMs,
      lastMessageAtMs: this.lastMessageAtMs,
      lastLogAtMs: this.lastLogAtMs,
      lastStatusAtMs: this.lastStatusAtMs,
      dedupSize: this.seen.size,
      ...this.metrics,
      ...extra,
    };
  }
}

module.exports = {
  PumpFlowStream,
  buildTransactionFilters,
  buildTransactionStatusFilters,
};
