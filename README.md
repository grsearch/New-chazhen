# Same-Slot Dump Backrun v2

这是一个只做研究的 PumpSwap **Post-Dump Recovery / Toxic Flow Filter** 项目。它从
[Flow-Acceleration](https://github.com/grsearch/Flow-Acceleration) 的 Pump 事件解析、流式去重、
储备报价和 SQLite 思路重建而来，但已删除旧 Shadow 策略、LiveTradingManager、Primary 信号、
旧部署配置和历史数据库代码。

项目名字保留 “Same-Slot Dump Backrun”，但策略不再假设机器人能插入已经完成的同一 Slot。
同 Slot 交易只用于研究标签；真正的模拟入场必须先看到下一 Slot 或后续 Slot 的公开恢复证据。

> 当前代码不会读取私钥，不会签名，也没有发送交易的实现。

## 策略流程

1. **Stream Ingestion**：订阅 Pump Program 与全部 PumpSwap Program 交易，解析官方事件字段。
2. **Slot Assembler**：记录 `slot / transactionIndex / instructionIndex / eventIndex / signature`。
   没有 `transactionIndex` 时标记为 `SLOT_CORRELATED`，绝不声称存在严格链上先后顺序。
3. **Dump Detector**：用卖出前 Quote Reserve 比例、Token Reserve 比例、跌幅、剩余流动性和池龄识别砸盘。
4. **Toxic Flow Filter**：在信号时点用 Creator、已知毒性钱包、机械上涨、买家集中度等因果信息过滤。
5. **Recovery Confirmer**：同 Slot 买单仅统计；下一 Slot/后续 Slot 必须同时满足价格恢复、多钱包、真实金额、资金流和无二次砸盘。
6. **Execution Simulator**：分别模拟确认后 100/200/400/800ms 与下一 Slot 入场，仓位为 0.02/0.05/0.1 SOL。
7. **Research Store**：批量写入 SQLite，`NO_ENTRY` 与 `NO_EXIT` 独立保存，不编造止损成交价。
8. **Minimal Dashboard**：展示事件数、排序覆盖、恢复率、Fill Rate、NO_EXIT、PF、最差 5% 和分组结果。

## 初始研究组

Dump 分层：

| ID | Sell / 卖前 Quote | 跌幅 | 卖后 Quote | 最小池龄 |
|---|---:|---:|---:|---:|
| `D5-P15-Q20-A1` | 5% | 15% | 20 SOL | 1 分钟 |
| `D10-P25-Q50-A5` | 10% | 25% | 50 SOL | 5 分钟 |
| `D20-P40-Q100-A15` | 20% | 40% | 100 SOL | 15 分钟 |

恢复确认：

- `PD-R1`：后续 Slot；低点反弹 5%；收复跌幅 20%；至少 2 个有效买家；有效买入至少 0.5 SOL 且达到砸盘额 15%。
- `PD-R2`：最多 2 个 Slot；收复跌幅 30%；至少 3 个有效买家；买入/砸盘至少 25%；窗口净流入为正。
- `PD-LQ`：池龄至少 5 分钟、卖后 Quote 至少 50 SOL、1 秒和 3 秒净流入都为正，并满足多钱包和价格恢复。

默认把小于 0.05 SOL 的买单视为灰尘单。卖方、Creator、已配置关联钱包和历史毒性钱包的回补不计入恢复资金。

退出研究包括 1/2/3/5/10 秒固定持有、收复原跌幅 50/75/100%、可执行报价止损、二次砸盘、
1 秒资金流转负、买家停止增长和最长持有。退出条件触发后还会等待 200ms，并使用之后第一笔可观察储备报价；
超时则记录 `NO_EXIT`。

## 报价与费用口径

实现依据 Pump 官方资料：PumpSwap 是常数乘积 AMM；Quote 侧的有效储备为
`pool_quote_token_account.amount + virtual_quote_reserves`，其中 virtual 值是 signed `i128`。
解析器保留事件中的 LP、Protocol、Coin Creator、Cashback、Buyback 费率和原始数值。

- [PumpSwap 官方说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)
- [PumpSwap 官方 IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)
- [动态费用官方说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md)

模拟器版本为 `PUMPSWAP_CPMM_EVENT_FEES_V1`：使用每笔事件的有效储备和费率，再叠加配置的买卖滑点、
Priority Fee、Jito Tip 与基础交易费。它是事件流可实现性研究模型，不是链上 SDK 的逐指令报价替代品。

卖前价格优先使用 5 秒内最后一笔公开储备价格；缺失时才用 SellEvent 的卖后储备重建，并把来源写入数据库。
Token 精度优先来自交易 Token Balance；缺失时使用 Pump 默认 6 位并标记 `PUMP_DEFAULT`。

## 安装与运行

实时 Yellowstone gRPC 采集建议使用 Linux 或 WSL2。需要 Node.js 22+、pnpm，以及编译
`better-sqlite3` 所需的 Python、C/C++ 构建工具。

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

把 `.env` 中的 `SDBR_GRPC_TOKEN` 换成自己的 LaserStream Token。Dashboard 默认地址：
`http://127.0.0.1:8787`。

也可回放已经标准化为一行一个 JSON 事件的 JSONL：

```bash
pnpm replay ./events.jsonl
```

## 数据表

- `trades`：原始 AMM 事件、完整排序坐标、原始金额、储备、精度和逐笔费用。
- `slot_summaries`：transaction index 覆盖与 Slot 完整性统计。
- `dump_events`：独立砸盘事件、毒性结果、恢复进度、生存率和二次砸盘。
- `confirmations`：R1/R2/LQ 的确认时点与全部恢复特征。
- `simulations`：每个延迟、仓位、退出组合的请求时间、实际报价时间、Fill、成本与收益。
- `toxic_wallets`：只由已经结束的历史事件积累，供未来信号使用，避免前视偏差。

## 当前边界

- LaserStream 没有提供 `transactionIndex` 时，只能证明同 Slot 相关，不能证明严格执行顺序。
- 仅靠事件流无法可靠计算 Top Holder 或钱包关联集群；当前只支持信号前已知的 Creator、配置名单和历史毒性记录。
- 未使用 RPC 补历史池龄。进程启动前已经存在的池子以“已观察时长下限”表示，因此初期会保守地拒绝池龄门槛。
- 本项目不包含实盘执行。只有在 100–300 个独立事件、两个不重合时间窗口、全成本 PF ≥ 1.3、
  200–500ms 延迟仍为正、最差 5% 可控且 Exit Fill Rate 可接受后，才应讨论下一阶段。

## 检查

```bash
pnpm check
pnpm test
```

测试覆盖有效储备、signed virtual reserve、逐笔费用、Token 精度、严格/相关 Slot 标签、
Creator 拒绝、多钱包恢复、延迟入场、延迟退出、SQLite 批量写入和 `NO_EXIT` 独立统计。
