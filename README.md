# Post-Dump Recovery / Toxic Flow Filter

这是一个只做研究的 PumpSwap **Post-Dump Recovery / Toxic Flow Filter** 项目。它从
[Flow-Acceleration](https://github.com/grsearch/Flow-Acceleration) 的 Pump 事件解析、流式去重、
储备报价和 SQLite 思路重建而来，但已删除旧 Shadow 策略、LiveTradingManager、Primary 信号、
旧部署配置和历史数据库代码。

项目将两个研究口径硬隔离：主策略只在下一 Slot 或后续 Slot 出现公开恢复证据后模拟入场；
Same-Slot 只作为基础设施观察组，固定标记为不可执行，不生成确认、仓位或收益。

> 当前代码不会读取私钥，不会签名，也没有发送交易的实现。

## 策略流程

1. **Stream Ingestion**：订阅 Pump Program 与全部 PumpSwap Program 交易，解析官方事件字段。
2. **Slot Assembler**：记录 `slot / transactionIndex / instructionIndex / eventIndex / signature`。
   没有 `transactionIndex` 时标记为 `SLOT_CORRELATED`，绝不声称存在严格链上先后顺序。
3. **Dump Detector**：用卖出前 Quote Reserve 比例、Token Reserve 比例、跌幅、剩余流动性和池龄识别砸盘。
4. **Toxic Flow Filter**：在信号时点用 Creator、已知毒性钱包、机械上涨、买家集中度等因果信息过滤。
5. **Same-Slot Probe**：独立记录同 Slot 后续买单的严格排序、金额和本地接收延迟，永不触发交易模拟。
6. **Recovery Confirmer**：下一 Slot/后续 Slot 必须同时满足价格恢复、多钱包、真实金额、资金流和无二次砸盘。
7. **Execution Simulator**：分别模拟确认后 100/200/400/800ms 与确认后的下一 Slot 入场，仓位为 1/2/5 SOL。等待入场期间一旦出现二次砸盘，全部待入场组合立即取消；每个仓位还必须通过即时往返成本和双边流动性占用检查。

程序启动时会清理数据库中已经停用的 0.02/0.05/0.1 SOL 历史模拟记录；Dashboard 和统计只保留 1/2/5 SOL 研究仓位。砸盘与恢复事件本身不会被删除。旧 V1/V2 模拟不会与当前 V3 结果混合；历史确认保留，并明确统计为“确认但无有效模拟”。
8. **Research Store**：只把砸盘前5秒及其恢复/执行窗口写入 SQLite；无关的全网逐笔成交只在短时内存窗口中处理。`NO_ENTRY` 与 `NO_EXIT` 独立保存，不编造止损成交价。
9. **Minimal Dashboard**：分开展示 Same-Slot 观察、后续 Slot 主策略、Fill Rate、NO_EXIT、PF 和分组结果；同时显示独立已退出事件、盈利事件、确认模拟覆盖率和最大赢家事件贡献，避免把大量参数组合误当成独立样本。

## 两条研究线

### 主策略：Post-Dump Recovery

恢复确认必须满足 `slotDelta > 0`。引擎和执行模拟器各自设有一道硬性防护，任何同 Slot 确认都不会进入
`confirmations` 或 `simulations`。最早路径是“Slot N 砸盘 → Slot N+1 确认 → 确认后延迟报价入场”。

### 观察组：Same-Slot Infrastructure Probe

观察组只回答“砸盘完成后，同 Slot 是否还能看到后续买单，以及本地晚了多少毫秒”。有 transaction index 时记录
`STRICT_AFTER_DUMP`，缺失时记录 `SLOT_CORRELATED`。两类记录的 `executable` 都永久为 `false`，不计入主策略的
胜率、PF、Entry Fill 或收益。

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
解析器保留事件中的 LP、Protocol、Coin Creator、Cashback、Buyback 费率和原始数值。按官方 SDK，
可执行交易费只包含 LP、Protocol 与 Coin Creator；`buyback_fee_basis_points` 是费用分配比例，不能再作为
一笔额外交易费叠加。

- [PumpSwap 官方说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)
- [PumpSwap 官方 IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)
- [动态费用官方说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md)

模拟器版本为 `PUMPSWAP_CPMM_CAUSAL_CAPACITY_V3`：使用每笔事件的有效储备和可执行费率，再叠加配置的买卖滑点、
Priority Fee、Jito Tip 与基础交易费。入场前会在加入 Shadow 买单后的反事实储备上计算立即卖回的SOL，默认拒绝即时净往返损失超过8%、买入或卖出流动性占用超过10%的仓位。它是事件流可实现性研究模型，不是链上 SDK 的逐指令报价替代品。

V1 曾把 5000 bps 的 Buyback 分配比例误当成 50% 额外交易费；V2 虽修正费用，却允许确认后的等待期出现二次砸盘后继续入场。程序启动时会删除V1/V2派生模拟，但保留砸盘事件和恢复确认；这些确认会在Dashboard中标记为没有当前模型模拟，避免与V3收益混合。

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

## 每日 COS 数据上传

服务器使用 systemd Timer 在每天北京时间 **07:00** 导出最近24小时研究数据并上传腾讯 COS。Timer 明确绑定
`Asia/Shanghai`，不依赖服务器自身时区；`Persistent=true` 会在服务器错过执行时间后补跑一次。

```bash
sudo SERVICE_USER=ubuntu bash deploy/install-daily-export.sh /home/ubuntu/New-chazhen
sudoedit /etc/new-chazhen/backup-cos.env
sudo SERVICE_USER=ubuntu bash deploy/install-daily-export.sh /home/ubuntu/New-chazhen
```

配置模板位于 `deploy/backup-cos.env.example`，真实 Secret ID 和 Secret Key 只能保存在服务器的
`/etc/new-chazhen/backup-cos.env`，不要写入项目 `.env` 或提交到 Git。安装器只有在 COS 配置完整、
新 07:00 Timer 通过 systemd 校验并启用后，才会停用旧的 `flow-acceleration-backup.timer`（08:00）。
已有服务器可以只读复用 `/etc/flow-acceleration/backup-cos.env` 中的旧凭据，无需复制 Secret。

手动检查：

```bash
sudo systemctl start post-dump-recovery-backup.service
systemctl list-timers post-dump-recovery-backup.timer --all
cat /home/ubuntu/New-chazhen/data/exports/last-run.env
```

上传包包含24小时窗口数据库、Schema、Manifest、Git 提交号和逐文件 SHA-256；上传主文件和校验文件后，
脚本还会向 COS 查询远端对象，确认存在才记录 `DONE`。旧的本地导出默认保留2天。

## 程序内置健康检查

健康检查完全在本机进程内运行，不调用 OpenClaw、LLM 或任何按 Token 计费的服务：

- LaserStream 每2秒检查一次数据新鲜度，默认15秒无消息便自动断开并轮换端点重连。
- 总健康监控每60秒检查 Stream 状态、最近事件时间、SQLite 待写队列、新增写入错误和磁盘余量。
- 默认在剩余空间低于10GB或10%时进入 `DEGRADED`，防止数据库再次写满系统盘。
- 正常时每10分钟只向 systemd Journal 写一条简短日志。
- 连续5次异常（默认约5分钟）才退出进程；服务器现有的 `Restart=always` 会自动拉起。
- `/api/health` 的 `runtime.status` 会显示 `STARTING`、`HEALTHY` 或 `DEGRADED`。

因此不应再配置 OpenClaw 每10分钟轮询。可选环境变量包括
`SDBR_HEALTH_CHECK_MS`、`SDBR_HEALTH_MAX_EVENT_STALE_MS`、`SDBR_HEALTH_MAX_PENDING_WRITES`、
`SDBR_HEALTH_MIN_DISK_FREE_GB`、`SDBR_HEALTH_MIN_DISK_FREE_PCT`、
`SDBR_HEALTH_FATAL_CHECKS` 和 `SDBR_HEALTH_EXIT_ON_FATAL`。

## SQLite 容量控制

程序不再永久保存全部 PumpSwap 成交。Dump Detector 只在内存里保留检测所需的5秒历史；一旦识别到砸盘，才回填该池的砸盘前窗口，并继续保存恢复确认、Shadow 入场和退出所使用的成交。结构化字段默认完整保留，重复的 `raw_json` 默认关闭。

事件窗口成交和 Slot 摘要默认保留30天，后台每10分钟分批清理；`dump_events`、`confirmations`、`same_slot_observations`、`simulations` 与 `toxic_wallets` 不自动删除。SQLite 删除旧行后会复用空闲页，因此新库会稳定在有限大小，但旧的大文件需要一次性压缩迁移才能立即归还系统盘空间：

```bash
node scripts/compact-event-window-db.js \
  --source /home/ubuntu/New-chazhen/data/sdbr-research.db \
  --destination /home/ubuntu/New-chazhen/data/sdbr-research.compact.db
```

该命令不会覆盖或删除源库。它保留所有研究结果，只复制每个砸盘前5秒至后60秒的成交，并清空重复 `raw_json`。确认新库和 Dashboard 正常后，再由管理员决定是否删除旧39GB库。

## 数据表

- `trades`：仅限砸盘研究窗口的 AMM 事件、完整排序坐标、原始金额、储备、精度和逐笔费用。
- `slot_summaries`：transaction index 覆盖与 Slot 完整性统计。
- `dump_events`：独立砸盘事件、毒性结果、恢复进度、生存率和二次砸盘。
- `confirmations`：R1/R2/LQ 的确认时点与全部恢复特征。
- `same_slot_observations`：不可执行的同 Slot 后续买单、排序可信度、金额和接收延迟。
- `simulations`：每个延迟、仓位、退出组合的请求时间、实际报价时间、Fill、成本与收益。
- `toxic_wallets`：只由已经结束的历史事件积累，供未来信号使用，避免前视偏差。

## 当前边界

- LaserStream 没有提供 `transactionIndex` 时，只能证明同 Slot 相关，不能证明严格执行顺序。
- 即使存在严格排序的同 Slot 后续买单，也只是已经执行交易的观察结果，不代表机器人可以回到该位置成交。
- 仅靠事件流无法可靠计算 Top Holder 或钱包关联集群；当前只支持信号前已知的 Creator、配置名单和历史毒性记录。
- 未使用 RPC 补历史池龄。进程启动前已经存在的池子以“已观察时长下限”表示，因此初期会保守地拒绝池龄门槛。
- 当前退出报价使用退出时观察到的公开池状态，没有把 Shadow 买入后的反事实储备逐笔重放；审计显示现有样本偏差约 0.01%–0.5%，
  对 5 SOL 影响更明显。V3 已在入场容量检查中正确更新一次买入后的储备，但持仓期间的后续公开成交仍未做完整反事实状态重放；实盘化前必须完成状态化回放。
- 本项目不包含实盘执行。只有在 100–300 个独立事件、两个不重合时间窗口、全成本 PF ≥ 1.3、
  200–500ms 延迟仍为正、最差 5% 可控且 Exit Fill Rate 可接受后，才应讨论下一阶段。

## 检查

```bash
pnpm check
pnpm test
```

测试覆盖有效储备、signed virtual reserve、逐笔费用、Token 精度、严格/相关 Slot 标签、
Same-Slot 硬隔离、Creator 拒绝、多钱包恢复、延迟入场、延迟退出、SQLite 批量写入和 `NO_EXIT` 独立统计。
