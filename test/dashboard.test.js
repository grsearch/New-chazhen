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

test('dashboard only exposes the direct-dump managed matrix', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server', 'public', 'index.html'), 'utf8',
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'inline dashboard script must exist');
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /if\(refreshInFlight\)\{refreshQueued=true;return\}/);
  assert.match(source, /AbortController/);
  assert.doesNotMatch(source, /Promise\.all\(\[/);
  assert.match(source, /const PAGE_SIZE=20/);
  assert.match(source, /pageSize=\$\{PAGE_SIZE\}/);
  assert.match(source, /direct-dumps\?page=\$\{state\.dumpPage\}&pageSize=\$\{PAGE_SIZE\}/);
  assert.match(source, /id="strategy-pager"/);
  assert.match(source, /id="dump-pager"/);
  assert.match(source, /PumpSwap 迁移后砸单反弹矩阵/);
  assert.match(source, /砸单≥5 SOL/);
  assert.match(source, /冲击跌幅≥8%/);
  assert.match(source, /每个策略仓位固定1 SOL/);
  assert.match(source, /PUMPSWAP_DIRECT_DUMP_MANAGED_V2/);
  assert.match(source, /lastHealth:null/);
  assert.match(source, /healthFresh\?healthResult\.value:state\.lastHealth/);
  assert.match(source, /receivesFullTransactionMetadata===true\?'完整交易':'暂不可用'/);
  assert.doesNotMatch(source, /receivesFullTransactionMetadata===false\?'轻量日志\+排序':'完整交易'/);
  assert.match(source, /pool\.rpcCalls==null\?'—':pool\.rpcCalls/);
  assert.match(source, /row=>quoteModel==null\|\|row\.quoteModel===quoteModel/);
  assert.doesNotMatch(source, /filter\(row=>row\.quoteModel==='PUMPSWAP_DIRECT_DUMP_MANAGED_V2'/);
  assert.match(source, /紧跟砸单后的首个可成交报价/);
  assert.match(source, /延迟100ms/);
  assert.match(source, /延迟300ms/);
  assert.match(source, /移动回撤/);
  assert.match(source, /最长30秒\/5分钟/);
  assert.match(source, /NO_EXIT全损均值/);
  assert.match(source, /固定单仓','1 SOL'/);
  assert.doesNotMatch(source, /Same-Slot|同 Slot Shadow|R2-A1|观察钱包|后续Slot恢复策略/);
  assert.doesNotMatch(source, /api\/same-slot|api\/watched-wallets/);
  assert.match(source, /const metric=v=>v==null\|\|v===''\?null/);
  assert.match(source, /<th>独立已结束事件<\/th>/);
  assert.match(source, /<th>NO_ENTRY原因<\/th>/);
  assert.match(source, /<th>NO_EXIT原因<\/th>/);
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
  const insertConfirmation = store.db.prepare(`
    INSERT INTO confirmations(
      confirmation_id,episode_id,profile_id,confirmed_at_ms,ordering_confidence,snapshot_json
    ) VALUES(?,?,?,?,?,'{}')
  `);
  for (let index = 0; index < 23; index += 1) {
    insertConfirmation.run(
      `direct-${index}`, `episode-${index}`, 'DBM-S-D8', index, 'STRICT',
    );
  }
  const insertWatched = store.db.prepare(`
    INSERT INTO watched_wallet_trades(
      observation_id,wallet,received_at_ms,event_index,signature,
      ordering_confidence,mint,pool,side,sol_amount
    ) VALUES(?,?,?,?,?,'STRICT',?,?,?,?)
  `);
  for (let index = 0; index < 23; index += 1) {
    insertWatched.run(
      `watched-${index}`, 'wallet', index, 0, `signature-${index}`,
      `mint-${index}`, `pool-${index}`, 'BUY', index,
    );
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

  const directResponse = await fetch(
    `http://127.0.0.1:${port}/api/direct-dumps?page=2&pageSize=10`,
  );
  assert.equal(directResponse.status, 200);
  const direct = await directResponse.json();
  assert.equal(direct.page, 2);
  assert.equal(direct.total, 23);
  assert.equal(direct.items.length, 10);
  assert.equal(direct.items[0].signal_profile_id, 'DBM-S-D8');

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

  const walletResponse = await fetch(
    `http://127.0.0.1:${port}/api/watched-wallets?page=2&pageSize=10`,
  );
  assert.equal(walletResponse.status, 200);
  const wallet = await walletResponse.json();
  assert.equal(wallet.page, 2);
  assert.equal(wallet.total, 23);
  assert.equal(wallet.items.length, 10);
  assert.equal(wallet.items[0].observation_id, 'watched-12');
});

test('dashboard caches expensive summaries and reads without forcing a database flush', async (context) => {
  let summaryCalls = 0;
  const summaryOptions = [];
  const store = {
    summary(options) {
      summaryCalls += 1;
      summaryOptions.push(options);
      return { sequence: summaryCalls };
    },
  };
  const dashboard = new DashboardServer({
    config: { host: '127.0.0.1', port: 0, summaryCacheMs: 60_000 },
    store,
    health: () => ({ state: 'TEST' }),
  });
  context.after(async () => dashboard.stop());
  await dashboard.start();
  const port = dashboard.server.address().port;

  const first = await fetch(`http://127.0.0.1:${port}/api/summary`).then((r) => r.json());
  const second = await fetch(`http://127.0.0.1:${port}/api/summary`).then((r) => r.json());
  assert.deepEqual(first, { sequence: 1 });
  assert.deepEqual(second, { sequence: 1 });
  assert.equal(summaryCalls, 1);
  assert.deepEqual(summaryOptions, [{ flushPending: false }]);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.dashboard.summaryRequests, 2);
  assert.equal(health.dashboard.summaryComputations, 1);
  assert.equal(health.dashboard.summaryCacheHits, 1);
});
