'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const {
  ResearchStore, compareCohortPerformance, returnStats, eventConcentrationStats,
} = require('../src/data/ResearchStore');
const { DashboardServer } = require('../src/server/DashboardServer');

test('cohorts sort by win rate and then average net return', () => {
  const highWin = { winRatePct: 80, averageNetReturnPct: 1, resolved: 10, scheduled: 10 };
  const highReturn = { winRatePct: 70, averageNetReturnPct: 50, resolved: 10, scheduled: 10 };
  assert.ok(compareCohortPerformance(highWin, highReturn) < 0, 'win rate is the primary sort');
  assert.ok(compareCohortPerformance(
    { ...highWin, averageNetReturnPct: 5 }, highWin,
  ) < 0, 'average return breaks equal-win-rate ties');
  assert.ok(compareCohortPerformance(highWin, { winRatePct: null, averageNetReturnPct: null }) < 0);
  assert.equal(returnStats([]).profitFactor, null, 'PF is unknown when no trade has closed');
  const eventStats = eventConcentrationStats([
    { episodeId: 'winner', net_return_pct: 10 },
    { episodeId: 'winner', net_return_pct: 5 },
    { episodeId: 'loser', net_return_pct: -2 },
  ]);
  assert.equal(eventStats.resolvedEpisodes, 2);
  assert.equal(eventStats.episodesWithAnyWin, 1);
  assert.equal(eventStats.largestWinnerEventContributionPct, 100);
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
  assert.match(source, /same-slot\?page=\$\{state\.sameSlotPage\}&pageSize=\$\{PAGE_SIZE\}/);
  assert.match(source, /id="same-slot-pager"/);
  assert.match(source, /id="same-slot-shadow-pager"/);
  assert.match(source, /核心：R2-B2 与 Same-Slot Shadow 对照组/);
  assert.match(source, /Rank#2买单间隔P50/);
  assert.match(source, /含NO_EXIT=-15%/);
  assert.match(source, /Jito 0\.01/);
  assert.match(source, /Rank#\$\{r\.targetRank\}/);
  assert.match(source, /Shadow平均净收益/);
  assert.match(source, /Rank#1延迟P50/);
  assert.match(source, /<th>观测排名<\/th>/);
  assert.match(source, /<th>链上Tx位置<\/th>/);
  assert.match(source, /R2-B2独立事件/);
  assert.match(source, /数据异常\/旧解析/);
  assert.match(source, /const metric=v=>v==null\|\|v===''\?null/);
  assert.match(source, /<th>独立CLOSED<\/th>/);
  assert.match(source, /<th>NO_ENTRY原因<\/th>/);
  assert.match(source, /<th>NO_EXIT原因<\/th>/);
  assert.match(source, /胜率 ↓ · 平均净收益 ↓/);
  assert.match(source, /最大赢家事件贡献/);
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
  const insertSameSlot = store.db.prepare(`
    INSERT INTO same_slot_observations(
      observation_id,episode_id,mint,pool,observed_at_ms,slot,event_index,
      classification,receive_lag_ms,buy_sol,executable,rejection_reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)
  `);
  for (let index = 0; index < 23; index += 1) {
    insertSameSlot.run(
      `observation-${index}`, `episode-${index}`, `mint-${index}`, `pool-${index}`,
      index, index, 0, 'STRICT_AFTER_DUMP', 10, 1,
      'OBSERVED_AFTER_EXECUTION_NO_SAME_SLOT_GUARANTEE',
    );
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

  const sameSlotResponse = await fetch(
    `http://127.0.0.1:${port}/api/same-slot?page=2&pageSize=10`,
  );
  assert.equal(sameSlotResponse.status, 200);
  const sameSlot = await sameSlotResponse.json();
  assert.equal(sameSlot.page, 2);
  assert.equal(sameSlot.pageSize, 10);
  assert.equal(sameSlot.total, 23);
  assert.equal(sameSlot.totalPages, 3);
  assert.equal(sameSlot.items.length, 10);
  assert.equal(sameSlot.items[0].observation_id, 'observation-12');
});
