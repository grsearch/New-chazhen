'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

class DashboardServer {
  constructor({ config, store, health }) {
    this.config = { summaryCacheMs: 30_000, ...config };
    this.store = store;
    this.healthProvider = health;
    this.server = null;
    this.indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    this.summaryCache = null;
    this.metrics = {
      summaryRequests: 0,
      summaryComputations: 0,
      summaryCacheHits: 0,
      summaryErrors: 0,
      lastSummaryDurationMs: null,
      lastSummaryAtMs: null,
    };
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((request, response) => this._handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, resolve);
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  _summary() {
    const now = Date.now();
    this.metrics.summaryRequests += 1;
    if (this.summaryCache
      && now - this.summaryCache.generatedAtMs < this.config.summaryCacheMs) {
      this.metrics.summaryCacheHits += 1;
      return this.summaryCache.value;
    }
    const startedAtMs = Date.now();
    try {
      const value = this.store.summary({ flushPending: false });
      const generatedAtMs = Date.now();
      this.summaryCache = { value, generatedAtMs };
      this.metrics.summaryComputations += 1;
      this.metrics.lastSummaryDurationMs = generatedAtMs - startedAtMs;
      this.metrics.lastSummaryAtMs = generatedAtMs;
      return value;
    } catch (error) {
      this.metrics.summaryErrors += 1;
      if (this.summaryCache) {
        this.metrics.summaryCacheHits += 1;
        return this.summaryCache.value;
      }
      throw error;
    }
  }

  health() {
    return {
      ...this.metrics,
      summaryCacheMs: this.config.summaryCacheMs,
      summaryCacheAgeMs: this.summaryCache
        ? Math.max(0, Date.now() - this.summaryCache.generatedAtMs) : null,
    };
  }

  _handle(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' });
      if (url.pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': this.indexHtml.length,
          'cache-control': 'no-store',
        });
        response.end(this.indexHtml);
        return;
      }
      const limit = Number(url.searchParams.get('limit') || 100);
      if (url.pathname === '/api/summary') return sendJson(response, 200, this._summary());
      if (url.pathname === '/api/dumps') {
        if (url.searchParams.has('page') || url.searchParams.has('pageSize')) {
          return sendJson(response, 200, this.store.recentDumpsPage(
            Number(url.searchParams.get('page') || 1),
            Number(url.searchParams.get('pageSize') || 20),
            { flushPending: false },
          ));
        }
        return sendJson(response, 200, this.store.recentDumps(
          limit, { flushPending: false },
        ));
      }
      if (url.pathname === '/api/direct-dumps') {
        return sendJson(response, 200, this.store.recentDirectDumpsPage(
          Number(url.searchParams.get('page') || 1),
          Number(url.searchParams.get('pageSize') || 20),
          { flushPending: false },
        ));
      }
      if (url.pathname === '/api/simulations') {
        return sendJson(response, 200, this.store.recentSimulations(
          limit, { flushPending: false },
        ));
      }
      if (url.pathname === '/api/watched-wallets') {
        return sendJson(response, 200, this.store.recentWatchedWalletTradesPage(
          Number(url.searchParams.get('page') || 1),
          Number(url.searchParams.get('pageSize') || 20),
          { flushPending: false },
        ));
      }
      if (url.pathname === '/api/same-slot') {
        if (url.searchParams.has('page') || url.searchParams.has('pageSize')) {
          return sendJson(response, 200, this.store.recentSameSlotObservationsPage(
            Number(url.searchParams.get('page') || 1),
            Number(url.searchParams.get('pageSize') || 20),
            { flushPending: false },
          ));
        }
        return sendJson(response, 200, this.store.recentSameSlotObservations(
          limit, { flushPending: false },
        ));
      }
      if (url.pathname === '/api/health') {
        return sendJson(response, 200, {
          ...this.healthProvider(),
          dashboard: this.health(),
        });
      }
      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, 500, { error: error.message });
    }
  }
}

module.exports = { DashboardServer };
