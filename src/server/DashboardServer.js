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
    this.config = config;
    this.store = store;
    this.healthProvider = health;
    this.server = null;
    this.indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
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
      if (url.pathname === '/api/summary') return sendJson(response, 200, this.store.summary());
      if (url.pathname === '/api/dumps') return sendJson(response, 200, this.store.recentDumps(limit));
      if (url.pathname === '/api/simulations') {
        return sendJson(response, 200, this.store.recentSimulations(limit));
      }
      if (url.pathname === '/api/health') return sendJson(response, 200, this.healthProvider());
      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, 500, { error: error.message });
    }
  }
}

module.exports = { DashboardServer };
