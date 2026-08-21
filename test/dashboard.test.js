'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { ResearchStore, compareCohortPerformance } = require('../src/data/ResearchStore');
const { DashboardServer } = require('../src/server/DashboardServer');

test('cohorts sort by win rate and then average net return', () => {
  const highWin = { winRatePct: 80, averageNetReturnPct: 1, resolved: 10, scheduled: 10 };
  const highReturn = { winRatePct: 70, averageNetReturnPct: 50, resolved: 10, scheduled: 10 };
  assert.ok(compareCohortPerformance(highWin, highReturn) < 0, 'win rate is the primary sort');
  assert.ok(compareCohortPerformance(
    { ...highWin, averageNetReturnPct: 5 }, highWin,
  ) < 0, 'average return breaks equal-win-rate ties');
  assert.ok(compareCohortPerformance(highWin, { winRatePct: null, averageNetReturnPct: null }) < 0);
});

test('dashboard script parses and exposes paginated GMGN views', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server', 'public', 'index.html'), 'utf8',
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'inline dashboard script must exist');
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(source, /const PAGE_SIZE=20/);
  assert.match(source, /pageSize=\$\{PAGE_SIZE\}/);
  assert.match(source, /胜率 ↓ · 平均净收益 ↓/);
  assert.match(source, /https:\/\/gmgn\.ai\/sol\/token\/\$\{encodeURIComponent\(value\)\}/);
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
});

test('dashboard dump endpoint returns pagination metadata', async (context) => {
  const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, batchMax: 1_000 });
  const insert = store.db.prepare(`
    INSERT INTO dump_events(
      episode_id,mint,pool,detected_at_ms,ordering_confidence,
      matched_dump_profiles_json,status,toxic_rejected,updated_at_ms
    ) VALUES(?,?,?,?,?,'[]','OBSERVING',0,?)
  `);
  for (let index = 0; index < 23; index += 1) {
    insert.run(`episode-${index}`, `mint-${index}`, `pool-${index}`, index, 'STRICT', index);
  }
  const dashboard = new DashboardServer({
    config: { host: '127.0.0.1', port: 0 }, store, health: () => ({ state: 'TEST' }),
  });
  context.after(async () => { await dashboard.stop(); store.close(); });
  await dashboard.start();
  const port = dashboard.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/dumps?page=2&pageSize=10`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 10);
  assert.equal(result.total, 23);
  assert.equal(result.totalPages, 3);
  assert.equal(result.items.length, 10);
  assert.equal(result.items[0].episode_id, 'episode-12');
});
