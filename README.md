# Same-Slot Dump Backrun / Speed Research

这是一个只做研究的 PumpSwap **Same-Slot Dump Backrun** 项目。它从
[Flow-Acceleration](https://github.com/grsearch/Flow-Acceleration) 的 Pump 事件解析、流式去重、
储备报价和 SQLite 思路重建而来，但已删除旧 Shadow 策略、LiveTradingManager、Primary 信号、
旧部署配置和历史数据库代码。

首要目标是研究“大砸单后能否成为同 Slot 第1或第2笔买入，并快速退出”。后续 Slot 的
Post-Dump Recovery 保留为对照组，用来判断当极速基础设施没有落地时，公开信息入场是否仍有收益。

> 当前代码不会读取私钥，不会签名，也没有发送交易的实现。

## 策略流程

1. **Stream Ingestion**：订阅 Pump Program 与全部 PumpSwap Program 交易，解析官方事件字段。
2. **Slot Assembler**：记录 `slot / transactionIndex / instructionIndex / eventIndex / signature`。
   没有 `transactionIndex` 时标记为 `SLOT_CORRELATED`，绝不声称存在严格链上先后顺序。
3. **Dump Detector**：用卖出前 Quote Reserve 比例、Token Reserve 比例、跌幅、剩余流动性和池龄识别砸盘。
4. **Same-Slot Speed Probe**：记录同 Slot 后续买单的严格链上排名、交易位置、金额和本地接收延迟。
5. **Same-Slot Shadow Simulator**：分别研究理论 Rank #1 与 Rank #2；Rank #2分为首买至少5 SOL的`R2-B5`验证组、至少2 SOL的`R2-B2`对照组和`R2-BASE`。使用1/2/5 SOL和100/250/500ms快速退出，主退出无报价时再研究5秒、10秒应急退出；所有结果强制标记为不可执行理论成交。
6. **Toxic Flow Filter**：在信号时点用 Creator、已知毒性钱包、机械上涨、买家集中度等因果信息过滤。
7. **Recovery Confirmer**：下一 Slot/后续 Slot 必须同时满足价格恢复、多钱包、真实金额、资金流和无二次砸盘。
8. **Recovery Execution Simulator**：作为对照组，分别模拟确认后 100/200/400/800ms 与确认后的下一 Slot 入场，仓位为 1/2/5 SOL。等待入场期间一旦出现二次砸盘，全部待入场组合立即取消；每个仓位还必须通过即时往返成本和双边流动性占用检查。

程序启动时会清理数据库中已经停用的 0.02/0.05/0.1 SOL 历史模拟记录；Dashboard 和统计只保留 1/2/5 SOL 研究仓位。砸盘与恢复事件本身不会被删除，但旧价格解析版本只保留供审计，不再进入策略统计。旧 V1/V2/V3 模拟不会与当前 V4 结果混合；历史确认保留，并明确统计为“确认但无有效模拟”。
9. **Research Store**：只把砸盘前5秒及其 Same-Slot/恢复/执行窗口写入 SQLite；无关的全网逐笔成交只在短时内存窗口中处理。`NO_ENTRY` 与 `NO_EXIT` 独立保存，不编造退出价格。
10. **Minimal Dashboard**：优先展示`R2-B5`验证样本、Same-Slot链上排名、23ms速度余量和应急退出；后续 Slot 恢复仅作为对照组。页面同时显示 Fill Rate、NO_EXIT与Jito合并情景收益、PF、独立事件、实际覆盖时长和异常隔离数量。

## 两条研究线

### 核心方向：Same-Slot Dump Backrun

Dashboard 的 `#1/#2` 表示砸盘后同 Slot 内已经上链的第1/第2笔严格排序买单。当前 LaserStream
在交易执行后才提供事件，因此这些行只能测量竞争环境和本地观察延迟，不能声称本系统已经能够取得该排名。

Same-Slot Shadow V2 建立四种可区分的反事实研究路径：

- `R1-RAW / Rank #1`：以砸盘事件执行后的公开储备为理论入场状态。
- `R2-BASE / Rank #2`：观察到严格排序的第1笔真实买单后，以该买单执行后的公开储备为理论入场状态。
- `R2-B2 / Rank #2`：第一笔严格同Slot买单至少2 SOL，继续作为宽松对照组。
- `R2-B5 / Rank #2`：第一笔严格同Slot买单至少5 SOL，是从2026-08-24数据中发现后冻结的验证组。旧记录重标为`DISCOVERY_RECLASSIFIED_20260824`，部署后的新记录进入`HOLDOUT_B5_V1`，两者不混合排名。阈值可用`SDBR_RANK2_STRONG_TRIGGER_BUY_SOL`配置，但验证期间不应继续按当天结果调参。
- 仓位固定为1/2/5 SOL，主退出目标为入场后100/250/500ms。
- 主退出使用目标时点之后第一笔严格因果公开成交的储备报价；2秒内没有报价时依次切换到5秒、10秒应急目标，每个目标各有2秒报价宽限。全部失败后才记录`NO_EXIT`。
- 每次入场都先检查即时买卖往返成本和双边流动性占用，并扣除AMM费用、滑点、基础费、Priority Fee与Jito Tip假设。
- 默认速度预算为解析2ms、构建5ms、签名1ms、发送15ms。Rank #1余量按“第一笔买单接收时间−砸盘接收时间−23ms”计算；Rank #2必须按“第二笔买单接收时间−第一笔买单接收时间−23ms”计算，不能再把第二笔买单相对砸盘的累计延迟误当成可用时间。预算可通过`SDBR_SPEED_*_BUDGET_MS`调整。
- `CLOSED均值`只统计真实取得退出报价的组合；Dashboard另列`NO_EXIT=-15%/-100% + Jito 0.01`合并情景，把无法退出与买卖两笔Jito成本同时纳入，避免分开查看造成误判。
- Jito敏感性仍保存每笔0/0.005/0.01/0.02 SOL档位，买入和卖出各计一次；这些只是假设成本，不代表获得指定链上排名。
- 成交额、Quote Reserve、成交/储备比例、事件价格与储备价格偏差或相邻储备跳变超过安全阈值时，相关组合标记为`QUARANTINED`，保留审计记录但不进入收益排名。

所有Shadow行都写入`infrastructure_executable=0`，并标记
`POST_EXECUTION_STREAM_NO_LANDING_GUARANTEE`。这个模型回答“如果能取得该排名，公开价格路径下收益如何”，
不回答“现有LaserStream系统是否真的能取得该排名”。由于假设订单会改变池子状态，V2仍是公开储备路径近似，
不是完整的反事实链上重放。

要把该方向变成可执行策略，需要单独的极速执行层：低延迟区块数据、预构建交易、Leader/Block Engine
直发、动态 Priority Fee/Jito Tip、账户预热和落地排名回执。Jito Bundle只能保证自己提交的Bundle内部顺序，
不能把已经执行的任意公开砸盘交易重新装进自己的Bundle。当前仓库尚未读取私钥或发送交易。

- [Jito低延迟交易与Bundle说明](https://docs.jito.wtf/lowlatencytxnsend/)
- [Jito低延迟区块数据说明](https://docs.jito.wtf/lowlatencytxnfeed/)

### 对照组：Post-Dump Recovery

恢复确认必须满足 `slotDelta > 0`。引擎和执行模拟器各自设有一道硬性防护，任何同 Slot 确认都不会进入
`confirmations` 或 `simulations`。最早路径是“Slot N 砸盘 → Slot N+1 确认 → 确认后延迟报价入场”。

Post-Dump对照组不使用同Slot资金。恢复确认必须进入后续Slot，并继续统计延迟、容量和退出成功率。

## 初始研究组

Dump 分层：

| ID | Sell / 卖前 Quote | 跌幅 | 卖后 Quote | 最小池龄 |
|---|---:|---:|---:|---:|
| `D5-P15-Q20-A1` | 5% | 15% | 20 SOL | 1 分钟 |
| `D10-P25-Q50-A5` | 10% | 25% | 50 SOL | 5 分钟 |

全局最大跌幅默认为40%；超过40%的卖单视为RUG/价格数据异常，不建立研究事件，也不进入Same-Slot或恢复收益统计。

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

模拟器版本为 `PUMPSWAP_CPMM_CAUSAL_CAPACITY_V4`：使用每笔事件的有效储备和可执行费率，再叠加配置的买卖滑点、
Priority Fee、Jito Tip 与基础交易费。入场前会在加入 Shadow 买单后的反事实储备上计算立即卖回的SOL，默认拒绝即时净往返损失超过8%、买入或卖出流动性占用超过10%的仓位。它是事件流可实现性研究模型，不是链上 SDK 的逐指令报价替代品。

V1 曾把 5000 bps 的 Buyback 分配比例误当成 50% 额外交易费；V2 虽修正费用，却允许确认后的等待期出现二次砸盘后继续入场。旧事件解析没有把多Token交易中的Token Account精确映射到各自PumpSwap事件，可能产生1000倍级价格异常。当前解析版本会标记到每个砸盘事件；程序启动时会隔离旧解析事件并删除V1/V2/V3派生模拟，避免它们继续污染恢复率、Same-Slot反弹和收益统计。旧行不会自动物理删除。

Same-Slot公开储备路径使用独立版本`PUMPSWAP_SAME_SLOT_PUBLIC_RESERVE_PATH_V2`。统计接口只汇总当前版本；恢复比例超过上限的事件及异常成交/储备连续性组合会从砸盘、确认、Same-Slot和后续Slot收益汇总中统一隔离并单独计数。原始行和旧Same-Slot行仍留在SQLite供审计，但不会与V2收益混合。

Same-Slot公开买单观测也保存独立的数据质量状态。新数据会根据成交额、Quote储备、成交/储备价格偏差、价格反弹上限及相邻储备连续性标记为`TRUSTED`或`QUARANTINED`；升级前无法完整重算的历史行保留为`UNASSESSED`，但成交额或价格反弹明显超过上限的历史行会自动隔离。`QUARANTINED`行仍保留在数据库和每日导出中，不参与Dashboard的金额均值、排名、延迟和最近观测列表。

Same-Slot退出统计分成两层：`主Exit`仅包含100/250/500ms目标及其2秒报价宽限内的退出，并报告真实持有时间P50/P95；`含救援Exit`再加入5秒和10秒救援。Dashboard同时显示“主窗口失败即按损失处理”和“保留救援实际结果”两种情景，避免用较慢的救援成交掩盖快速回跑策略本身的退出能力。

卖前价格优先使用 5 秒内最后一笔公开储备价格；缺失时才用 SellEvent 的卖后储备重建，并把来源写入数据库。
Token精度通过事件中的`user_base_token_account`映射到该账户自己的Token Balance。多Token交易无法完成账户映射时，
整笔事件不参与价格和策略计算，禁止再使用“全交易余额变化最大的Mint”作为猜测。

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

上传包包含24小时窗口数据库、Schema、Manifest、Git 提交号和逐文件 SHA-256。Manifest内置Go/No-Go研究就绪审计，自动检查实际Stream覆盖时长、Schema关键字段、观测质量已评估比例、R2-B5独立事件与独立币、主退出事件、Rank #2速度余量样本、终态完成率，以及1/2/5 SOL × 100/250/500ms九个组合是否齐全。`READY_FOR_GO_NO_GO_ANALYSIS`只表示数据足以进入人工分析，不代表程序自动批准实盘；最终仍需和另一不重合时间窗口交叉验证。上传主文件和校验文件后，
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

事件窗口成交和 Slot 摘要默认保留30天，后台每10分钟分批清理；`dump_events`、`confirmations`、`same_slot_observations`、`same_slot_shadow_simulations`、`simulations` 与 `toxic_wallets` 不自动删除。每个符合条件且非毒性的砸盘事件最多新增18条Same-Slot Shadow组合（2个排名×3个仓位×3个主退出时点）；5秒/10秒应急退出复用原组合，不新增参数行。SQLite 删除旧行后会复用空闲页，因此新库会稳定在有限大小，但旧的大文件需要一次性压缩迁移才能立即归还系统盘空间：

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
- `same_slot_observations`：不可执行的同 Slot 后续买单、排序可信度、金额、接收延迟和观测级数据质量状态。
- `same_slot_shadow_simulations`：理论Rank #1/#2入场、`R1-RAW/R2-BASE/R2-B2/R2-B5`分组、发现/验证样本标签、第一笔买单金额、正确的两买单间隔、速度余量、数据质量状态、容量检查、快速/应急退出和扣费收益。
- `simulations`：每个延迟、仓位、退出组合的请求时间、实际报价时间、Fill、成本与收益。
- `toxic_wallets`：只由已经结束的历史事件积累，供未来信号使用，避免前视偏差。

## 当前边界

- LaserStream 没有提供 `transactionIndex` 时，只能证明同 Slot 相关，不能证明严格执行顺序。
- 即使存在严格排序的同 Slot 后续买单，也只是已经执行交易的观察结果，不代表机器人可以回到该位置成交。
- 仅靠事件流无法可靠计算 Top Holder 或钱包关联集群；当前只支持信号前已知的 Creator、配置名单和历史毒性记录。
- 未使用 RPC 补历史池龄。进程启动前已经存在的池子以“已观察时长下限”表示，因此初期会保守地拒绝池龄门槛。
- 当前退出报价使用退出时观察到的公开池状态，没有把 Shadow 买入后的反事实储备逐笔重放；审计显示现有样本偏差约 0.01%–0.5%，
  对 5 SOL 影响更明显。V4 已在入场容量检查中正确更新一次买入后的储备，但持仓期间的后续公开成交仍未做完整反事实状态重放；实盘化前必须完成状态化回放。
- 本项目不包含实盘执行。只有在 100–300 个独立事件、两个不重合时间窗口、全成本 PF ≥ 1.3、
  200–500ms 延迟仍为正、最差 5% 可控且 Exit Fill Rate 可接受后，才应讨论下一阶段。

## 检查

```bash
pnpm check
pnpm test
```

测试覆盖有效储备、signed virtual reserve、逐笔费用、Token 精度、严格/相关 Slot 标签、
Same-Slot Rank #1/#2 Shadow、100/250/500ms快速退出与5秒/10秒应急退出、Creator拒绝、多钱包恢复、延迟入场、
延迟退出、Rank #2两买单间隔、`R2-B2/R2-B5`分组、发现/验证样本隔离、异常储备隔离、NO_EXIT/Jito合并情景收益、SQLite批量写入和`NO_EXIT`独立统计。
