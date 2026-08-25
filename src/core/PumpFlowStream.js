'use strict';

const EventEmitter = require('events');
const { extractSignature } = require('./PumpEventParser');

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

class PumpFlowStream extends EventEmitter {
  constructor({ config, connectionFactory = null }) {
    super();
    this.config = config;
    this.connectionFactory = connectionFactory;
    this.running = false;
    this.client = null;
    this.stream = null;
    this.endpointIndex = -1;
    this.retry = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.lastMessageAtMs = null;
    this.connectedAtMs = null;
    this.seen = new Map();
    this.metrics = {
      received: 0,
      duplicates: 0,
      reconnects: 0,
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
      this.connectedAtMs = Date.now();
      this.lastMessageAtMs = null;
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
    const request = proto(types.SubscribeRequest, {
      transactions: buildTransactionFilters(
        this.config, types.SubscribeRequestFilterTransactions,
      ),
      accounts: {}, slots: {}, blocks: {}, blocksMeta: {}, entry: {},
      transactionsStatus: {}, accountsDataSlice: [],
      commitment: types.CommitmentLevel.PROCESSED,
    });
    await new Promise((resolve, reject) => {
      stream.write(request, (error) => (error ? reject(error) : resolve()));
    });
    return { client, stream };
  }

  _onMessage(message) {
    if (!message?.transaction) return;
    const receivedAtMs = Date.now();
    this.lastMessageAtMs = receivedAtMs;
    const signature = extractSignature(message.transaction);
    if (signature && !this._first(signature, receivedAtMs)) {
      this.metrics.duplicates += 1;
      return;
    }
    this.metrics.received += 1;
    this.emit('transaction', message.transaction, { receivedAtMs, endpointIndex: this.endpointIndex });
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

  _unavailable(error, phase) {
    if (!this.running || this.reconnectTimer) return;
    this.metrics.errors += 1;
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
  }

  _startWatchdog() {
    this.watchdog = setInterval(() => {
      const last = this.lastMessageAtMs || this.connectedAtMs;
      if (!this.running || !last || this.reconnectTimer) return;
      if (Date.now() - last >= this.config.stream.staleTimeoutMs) {
        this._unavailable(new Error('LaserStream became stale'), 'STALE');
      }
    }, this.config.stream.staleCheckMs);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  async _close() {
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
    return {
      mode: includesPumpLifecycle
        ? 'ACTIVE_PASSIVE_PUMPSWAP_PLUS_PUMP_LIFECYCLE'
        : 'ACTIVE_PASSIVE_PUMPSWAP_ONLY',
      subscriptionFilters: includesPumpLifecycle
        ? ['pumpSwap', 'pumpLifecycle'] : ['pumpSwap'],
      exactMigrationTimestamps: includesPumpLifecycle,
      endpointIndex: this.endpointIndex,
      endpoint: this.endpointIndex >= 0 ? this.config.stream.endpoints[this.endpointIndex] : null,
      connectedAtMs: this.connectedAtMs,
      lastMessageAtMs: this.lastMessageAtMs,
      dedupSize: this.seen.size,
      ...this.metrics,
      ...extra,
    };
  }
}

module.exports = { PumpFlowStream, buildTransactionFilters };
