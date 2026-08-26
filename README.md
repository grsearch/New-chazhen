# Same/Next-Slot Dump Absorption Research

这是一个只做研究的 PumpSwap **Same-Slot Dump Backrun** 项目。它从
[Flow-Acceleration](https://github.com/grsearch/Flow-Acceleration) 的 Pump 事件解析、流式去重、
储备报价和 SQLite 思路重建而来，但已删除旧 Shadow 策略、LiveTradingManager、Primary 信号、
旧部署配置和历史数据库代码。

首要目标是研究“大砸单后能否成为同 Slot 第1或第2笔买入，并快速退出”。采集入口改为宽口径，
并行记录下一 Slot 的首个有效买入、累计吸收、价格反应和买家增长，避免用多个硬门槛提前删除样本。

> 当前代码不会读取实盘私钥，也不会发送交易。新增的测速层只使用进程内临时密钥，真实执行
> 本地构建、签名和序列化计时；交易不会离开本机，因此不会产生链上落地或排名数据。

## 策略流程

1. **Stream Ingestion**：默认使用轻量双流：WebSocket只接收PumpSwap事件日志，LaserStream只接收包含`slot / signature / transactionIndex`的交易状态，不再接收完整交易元数据；首次遇到新池时按需读取Pool和Mint账户以补齐Mint与精度。`full-transactions`保留为紧急回退模式。
2. **Slot Assembler**：记录 `slot / transactionIndex / instructionIndex / eventIndex / signature`。
   没有 `transactionIndex` 时标记为 `SLOT_CORRELATED`，绝不声称存在严格链上先后顺序。
3. **Dump Detector**：用卖出前 Quote Reserve 比例、Token Reserve 比例、跌幅、剩余流动性和池龄识别砸盘。
4. **Same-Slot Speed Probe**：记录同 Slot 后续买单的严格链上排名、交易位置、金额和本地接收延迟。
5. **Same-Slot Shadow Simulator**：分别研究理论 Rank #1 与 Rank #2；Rank #2按首买占砸盘额的比例标记为`R2-A1/A2/A5`，最低有效首买为`max(0.1 SOL, 砸盘额1%)`。1 SOL测试250/500/1000/2000ms，2/5 SOL只保留250/500ms容量敏感性；所有结果强制标记为不可执行理论成交。
6. **Toxic Flow Filter**：Creator、历史毒性钱包、机械上涨和买家集中度保留为因果风险特征。研究Shadow可以保留毒性负样本，但不会把它们标为可交易候选。
7. **N+1 Absorption Milestones**：`N1-FB/N1-A5/N1-P2/N1-B2`分别记录下一Slot首个有效买入、买入额达到砸盘额5%、价格反弹2%和两个独立买家的首次因果时点，并计算0–100吸收评分。
8. **Execution Simulator**：每个确认最多生成16个组合；1 SOL测试0/100/250ms响应与250/500/1000/2000ms退出，2/5 SOL只测试100ms响应和250/500ms退出。等待入场期间出现二次砸盘会立即取消。

程序启动时会清理数据库中已经停用的 0.02/0.05/0.1 SOL 历史模拟记录；Dashboard 和统计只保留 1/2/5 SOL 研究仓位。砸盘与恢复事件本身不会被删除，但旧价格解析版本只保留供审计，不再进入策略统计。旧 V1/V2/V3 模拟不会与当前 V4 结果混合；历史确认保留，并明确统计为“确认但无有效模拟”。
9. **Research Store**：只把砸盘前5秒及其 Same-Slot/恢复/执行窗口写入 SQLite；无关的全网逐笔成交只在短时内存窗口中处理。`NO_ENTRY` 与 `NO_EXIT` 独立保存，不编造退出价格。
10. **Minimal Dashboard**：展示宽口径事件数、吸收评分、Same-Slot排名、N+1里程碑、退出组合和观察钱包统计。真实发送被硬关闭，因此真实落地与排名样本始终明确显示为0。
11. **Wallet Research**：默认观察`popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz`在PumpSwap中的买卖、币种和砸盘附近Slot位置。它复用全网PumpSwap程序流，不新增订阅或RPC轮询；可通过`SDBR_WATCH_WALLETS`覆盖或追加地址。

## 两条研究线

### 核心方向：Same-Slot Dump Backrun

Dashboard 的 `#1/#2` 表示砸盘后同 Slot 内已经上链的第1/第2笔严格排序买单。当前 LaserStream
在交易执行后才提供事件，因此这些行只能测量竞争环境和本地观察延迟，不能声称本系统已经能够取得该排名。

Same-Slot Shadow V2 建立以下可区分的反事实研究路径：

- `R1-RAW / Rank #1`：以砸盘事件执行后的公开储备为理论入场状态。
- `R2-DUST / Rank #2`：第一笔买入低于`max(0.1 SOL, 砸盘额1%)`，作为灰尘/诱导负样本。
- `R2-A1/A2/A5 / Rank #2`：第一笔有效买入分别达到砸盘额1%、2%、5%；这是相对资金吸收分层，不再使用固定2/5/10 SOL硬门槛。
- 仓位固定为1/2/5 SOL。1 SOL主退出目标为入场后250/500/1000/2000ms；2/5 SOL只保留250/500ms容量敏感性。
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
不能把已经执行的任意公开砸盘交易重新装进自己的Bundle。当前仓库的极速测速层仅使用临时Keypair构建、
签名和序列化一笔零金额本地交易，硬编码`send_enabled=0`；`send_status=DISABLED`、
`landing_status=NOT_SENT`、`rank_status=NOT_MEASURABLE_WITHOUT_SEND`，不接受实盘私钥，也不存在发送路径。

每日导出以宽口径事件≥300、独立Mint≥150、同Slot事件≥100、下一Slot事件≥100、终态完成率≥95%
作为“可以开始统计分析”的最低门槛。达到门槛只会返回`READY_FOR_ANALYSIS / TRADING_DISABLED`，
不会自动开启实盘；收益、NO_EXIT全损、Jito成本和时间外样本仍需另行审计。

- [Jito低延迟交易与Bundle说明](https://docs.jito.wtf/lowlatencytxnsend/)
- [Jito低延迟区块数据说明](https://docs.jito.wtf/lowlatencytxnfeed/)

### 并行方向：N+1 Absorption 与 Post-Dump Recovery

恢复确认必须满足 `slotDelta > 0`。引擎和执行模拟器各自设有一道硬性防护，任何同 Slot 确认都不会进入
`confirmations` 或 `simulations`。最早路径是“Slot N 砸盘 → Slot N+1 确认 → 确认后延迟报价入场”。

`N1-FB/N1-A5/N1-P2/N1-B2`只允许在下一Slot首次达到条件时确认；传统`PD-R1/R2/LQ`
继续作为更慢恢复对照。两者都不使用同Slot资金，并持续统计延迟、容量和退出成功率。

吸收评分只使用当前时点已经发生的数据：累计买入/砸盘额、价格响应、独立买家、Quote保留、
净流入、二次砸盘和信号时毒性。评分用于后续分桶比较，不是当前实盘阈值。

## 初始研究组

Dump 分层：

| ID | Sell / 卖前 Quote | 跌幅 | 卖后 Quote | 最小池龄 |
|---|---:|---:|---:|---:|
| `D2-P5-Q20-RESEARCH` | 2% | 5% | 20 SOL | 0 |
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

Same-Slot退出统计分成两层：`主Exit`包含250/500/1000/2000ms目标及其2秒报价宽限内的退出，并报告真实持有时间P50/P95；`含救援Exit`再加入5秒和10秒救援。Dashboard同时显示“主窗口失败即按损失处理”和“保留救援实际结果”两种情景，避免用较慢的救援成交掩盖快速回跑策略本身的退出能力。

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

默认的`SDBR_STREAM_MODE=logs-status`才是真正的Helius轻量模式：迁移后的全部PumpSwap
日志仍会采集，并与LaserStream小体积transaction status按Signature合并，从而保留严格同Slot
排序，但不再为完整交易、账户列表和交易Meta付费。首次遇到新池时通常只需2次普通RPC读取
Pool/Mint账户，随后使用内存缓存。`SDBR_INCLUDE_PUMP_LIFECYCLE=false`继续排除迁移前Pump
Program全量交易，因此池龄来源为首次观察时间下限。紧急回退时可把`SDBR_STREAM_MODE`设为
`full-transactions`；只有该模式才允许重新打开Pump生命周期订阅。

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

上传包包含24小时窗口数据库、Schema、Manifest、Git提交号和逐文件SHA-256。Manifest自动检查实际Stream有效覆盖时长、首尾缺口、超过5秒的内部空洞、Schema关键字段、观测质量、宽口径事件/Mint、同Slot事件、下一Slot事件及模拟终态完成率，并单列观察钱包统计。覆盖率不再用首条到末条记录的简单跨度冒充。导出只报告`COLLECT_MORE_DATA`或`READY_FOR_ANALYSIS`，实盘决定始终为`TRADING_DISABLED`；最终仍需和另一不重合时间窗口交叉验证。上传主文件和校验文件后，
脚本还会向 COS 查询远端对象，确认存在才记录 `DONE`。旧的本地导出默认保留2天。

## 程序内置健康检查

健康检查完全在本机进程内运行，不调用 OpenClaw、LLM 或任何按 Token 计费的服务：

- LaserStream 每2秒检查一次数据新鲜度，默认15秒无消息便自动断开并轮换端点重连。
- 总健康监控每60秒检查 Stream 状态、最近事件时间、SQLite 待写队列、新增写入错误和磁盘余量。
- 轻量日志与交易状态默认最多等待30秒关联；Join质量按当前连接最近5分钟的成熟样本滚动计算，不把仍在等待的数据放进分母，也不会让旧连接的异常累计污染新连接。
- 启动宽限默认3分钟。成熟样本至少100条后，Join率连续2次低于90%只会定向重连日志流和状态流；自动恢复按2/4/8分钟退避，连续3次仍未恢复便暂停重连但继续采集，稳定健康5分钟后才重新启用。
- 默认在剩余空间低于10GB或10%时进入 `DEGRADED`，防止数据库再次写满系统盘。
- 正常时每10分钟只向 systemd Journal 写一条简短日志。
- 只有持续Stream失联、数据库写入异常等不可恢复问题连续5次出现，才退出进程；服务器现有的 `Restart=always` 会自动拉起。
- `/api/health` 的 `runtime.status` 会显示 `STARTING`、`HEALTHY` 或 `DEGRADED`。
- Dashboard历史汇总默认缓存30秒，页面每10秒刷新且禁止请求重叠；单个接口超时不会阻止其他表格显示，读取Dashboard也不会强制抢占SQLite待写队列。
- 轻量模式额外检查日志/交易状态合并率；最近窗口已有至少100条成熟结果且持续低于90%时，会进入`DEGRADED`并由进程定向重连两条Stream。

因此不应再配置 OpenClaw 每10分钟轮询。可选环境变量包括
`SDBR_HEALTH_CHECK_MS`、`SDBR_HEALTH_MAX_EVENT_STALE_MS`、`SDBR_HEALTH_MAX_PENDING_WRITES`、
`SDBR_HEALTH_MIN_DISK_FREE_GB`、`SDBR_HEALTH_MIN_DISK_FREE_PCT`、
`SDBR_HEALTH_STARTUP_GRACE_MS`、`SDBR_LOG_STATUS_JOIN_TTL_MS`、
`SDBR_LOG_STATUS_JOIN_WINDOW_MS`、`SDBR_LOG_STATUS_JOIN_BUCKET_MS`、
`SDBR_HEALTH_MIN_JOIN_SAMPLES`、`SDBR_HEALTH_MIN_JOIN_RATE_PCT`、
`SDBR_HEALTH_RECOVERY_CHECKS`、`SDBR_HEALTH_RECOVERY_COOLDOWN_MS`、
`SDBR_HEALTH_RECOVERY_BACKOFF_MULTIPLIER`、`SDBR_HEALTH_RECOVERY_MAX_COOLDOWN_MS`、
`SDBR_HEALTH_RECOVERY_MAX_ATTEMPTS`、`SDBR_HEALTH_RECOVERY_RESET_HEALTHY_MS`、
`SDBR_DASHBOARD_SUMMARY_CACHE_MS`、
`SDBR_HEALTH_FATAL_CHECKS` 和 `SDBR_HEALTH_EXIT_ON_FATAL`。

## SQLite 容量控制

程序不再永久保存全部 PumpSwap 成交。Dump Detector 只在内存里保留检测所需的5秒历史；一旦识别到砸盘，才回填该池的砸盘前窗口，并继续保存恢复确认、Shadow 入场和退出所使用的成交。结构化字段默认完整保留，重复的 `raw_json` 默认关闭。

事件窗口成交和 Slot 摘要默认保留30天，后台每10分钟分批清理；结构化研究结果不自动删除。每个砸盘事件最多新增16条Same-Slot Shadow组合；每个N+1确认最多新增16条执行模拟，避免旧版全笛卡尔积。5秒/10秒应急退出复用原组合，不新增参数行。SQLite删除旧行后会复用空闲页，因此新库会稳定在有限大小，但旧的大文件需要一次性压缩迁移才能立即归还系统盘空间：

```bash
node scripts/compact-event-window-db.js \
  --source /home/ubuntu/New-chazhen/data/sdbr-research.db \
  --destination /home/ubuntu/New-chazhen/data/sdbr-research.compact.db
```

该命令不会覆盖或删除源库。它保留所有研究结果，只复制每个砸盘前5秒至后60秒的成交，并清空重复 `raw_json`。确认新库和 Dashboard 正常后，再由管理员决定是否删除旧39GB库。

## 数据表

- `trades`：仅限砸盘研究窗口的 AMM 事件、完整排序坐标、原始金额、储备、精度、逐笔费用和`ingestion_mode`采集口径。
- `slot_summaries`：transaction index 覆盖与 Slot 完整性统计。
- `dump_events`：独立砸盘事件、毒性结果、恢复进度、0–100吸收评分、生存率和二次砸盘。
- `confirmations`：N1里程碑及传统R1/R2/LQ的确认时点、吸收评分和全部因果特征。
- `same_slot_observations`：不可执行的同 Slot 后续买单、排序可信度、金额、接收延迟和观测级数据质量状态。
- `same_slot_shadow_simulations`：理论Rank #1/#2入场、`R1-RAW/R2-DUST/R2-A1/A2/A5`分层、第一笔买单金额、两买单间隔、速度余量、数据质量、容量检查、快速/应急退出和扣费收益。
- `watched_wallet_trades`：观察钱包在PumpSwap中的最小结构化成交记录，不复制完整交易元数据。
- `candidate_excluded_mints`：仅为旧冻结候选历史数据兼容保留；新版宽口径研究默认不启用Mint排除。
- `execution_probes`：候选首买到达热路径时，临时Keypair在本机真实完成构建、签名和序列化的耗时与负载大小；Slot结束后再校验触发交易是否确为最终链上Rank #1。发送开关受数据库约束只能为0，链上落地和排名明确记录为未发送/不可测。
- `simulations`：每个延迟、仓位、退出组合的请求时间、实际报价时间、Fill、成本与收益。
- `toxic_wallets`：只由已经结束的历史事件积累，供未来信号使用，避免前视偏差。

## 当前边界

- 默认`logs-status`模式用两条独立数据流按Signature合并：事件字段来自PumpSwap公开日志，严格排序来自LaserStream transaction status。它不接收完整交易元数据，首次看到每个池通常需要2次普通RPC读取；Dashboard会显示合并率、待合并消息、日志近似字节和RPC次数。Helius最终计费以控制台为准，程序显示的日志MB不包含协议开销。
- 切换`SDBR_STREAM_MODE=full-transactions`可恢复旧的完整交易流，便于紧急对照，但会恢复高额LaserStream流量。轻量与完整模式分别写入`ingestion_mode`，分析时不可把接收延迟直接混为同一基础设施样本。
- LaserStream 没有提供 `transactionIndex` 时，只能证明同 Slot 相关，不能证明严格执行顺序。
- 即使存在严格排序的同 Slot 后续买单，也只是已经执行交易的观察结果，不代表机器人可以回到该位置成交。
- 仅靠事件流无法可靠计算 Top Holder 或钱包关联集群；当前只支持信号前已知的 Creator、配置名单和历史毒性记录。
- 未使用 RPC 补历史池龄。进程启动前已经存在的池子以“已观察时长下限”表示，因此初期会保守地拒绝池龄门槛。
- 当前退出报价使用退出时观察到的公开池状态，没有把 Shadow 买入后的反事实储备逐笔重放；审计显示现有样本偏差约 0.01%–0.5%，
  对 5 SOL 影响更明显。V4 已在入场容量检查中正确更新一次买入后的储备，但持仓期间的后续公开成交仍未做完整反事实状态重放；实盘化前必须完成状态化回放。
- 本项目不包含实盘执行。宽口径数据达到分析门槛后，仍需按吸收评分分桶、NO_EXIT全损、两个不重合时间窗口、最差5%和Exit Fill Rate进行人工评审；通过也只批准开发发送沙盒，不会自动投入SOL。

## 检查

```bash
pnpm check
pnpm test
```

测试覆盖有效储备、signed virtual reserve、逐笔费用、Token 精度、严格/相关 Slot 标签、
Same-Slot Rank #1/#2 Shadow、250/500/1000/2000ms退出与5秒/10秒应急退出、宽口径砸盘、N+1里程碑、吸收评分、观察钱包、Creator风险、多钱包恢复、延迟入场、Rank #2两买单间隔、临时Keypair本地测速、发送硬关闭、异常储备隔离、NO_EXIT/Jito全损情景、SQLite批量写入和`NO_EXIT`独立统计。
