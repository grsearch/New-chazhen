# PumpSwap Post-Migration Dump Bounce Research

这是一个只做研究的 PumpSwap **迁移后砸单反弹** 项目。它从
[Flow-Acceleration](https://github.com/grsearch/Flow-Acceleration) 的 Pump 事件解析、流式去重、
储备报价和 SQLite 思路重建而来，但已删除旧 Shadow 策略、LiveTradingManager、Primary 信号、
旧部署配置和历史数据库代码。

首要目标是完整记录 PumpSwap 中可重建负价格冲击的卖单，并研究“砸单后首个可用公开储备买入、
允许后续砸单独立加仓、每个仓位独立退出”的管理型策略。生产研究只运行这一套直接砸单矩阵。

> 当前代码不会读取实盘私钥，也不会发送交易。新增的测速层只使用进程内临时密钥，真实执行
> 本地构建、签名和序列化计时；交易不会离开本机，因此不会产生链上落地或排名数据。

## 策略流程

1. **Stream Ingestion**：默认使用轻量双流：WebSocket只接收PumpSwap事件日志，LaserStream只接收包含`slot / signature / transactionIndex`的交易状态，不再接收完整交易元数据；首次遇到新池时按需读取Pool和Mint账户以补齐Mint与精度。`full-transactions`保留为紧急回退模式。
2. **Slot Assembler**：记录 `slot / transactionIndex / instructionIndex / eventIndex / signature`。
   没有 `transactionIndex` 时标记为 `SLOT_CORRELATED`，绝不声称存在严格链上先后顺序。
3. **Dump Detector**：PumpSwap 本身是迁移后的 AMM 场所；对所有能重建卖前/卖后储备且产生负冲击的卖单建档，不以AGE、池深、毒性或固定跌幅作为采集门槛。
4. **Direct Dump Matrix**：按卖出量`5–10 / 10–25 / 25+ SOL`和跌幅`8–15 / 15–30 / 30%+`划分9个互斥桶；所有桶统一研究`1 SOL`，入场延迟为0/100/300ms。砸单交易不能作为成交，E0仍等待之后第一笔严格排序公开储备。
5. **Independent Add-On Lots**：同一池后续砸单建立新的独立仓位；旧仓不会因二次砸盘被取消或强制退出，各自维护入场、MFE/MAE、止盈、止损和最长持仓。
6. **Managed Exit Matrix**：5秒内快速止盈5%/8%/12%，移动止盈使用`激活8%/回撤3%`、`激活12%/回撤4%`或`激活16%/回撤5%`，最长持仓30秒/5分钟，并同时测试无固定止损与-12%固定止损，共36种退出配置。
7. **Toxic Flow Features**：Creator、历史毒性钱包、机械上涨和买家集中度只保留为事件特征；不会阻止达标直接砸单进入矩阵。
8. **Execution Simulator**：每个直接砸单生成`3入场 × 36退出 = 108`个独立模拟；默认只计0.0001 SOL Priority Fee、零Jito Tip和基础费，仍会扣除AMM费、滑点和容量冲击。

程序启动时会清理旧Same-Slot、下一Slot、观察钱包、执行探针和非当前报价模型的派生策略行；砸盘事件本身保留。新矩阵所有仓位统一使用1 SOL，Dashboard只汇总`PUMPSWAP_DIRECT_DUMP_MANAGED_V2`。
9. **Research Store / Dashboard**：只把砸盘前5秒及其独立持仓执行窗口写入 SQLite；`NO_ENTRY` 与 `NO_EXIT` 独立保存。真实发送仍硬关闭。

## 研究线

### 核心方向：Direct Dump Managed Matrix

- 采集全集为 PumpSwap 的负冲击卖单；`PUMPSWAP-ALL-DUMPS`不设AGE、最小池深或固定跌幅门槛，默认最大可记录跌幅为99%。
- 策略矩阵最低研究门槛为卖出5 SOL且冲击8%；低于该门槛仍记录为砸单事件，但不生成仓位矩阵。
- 9个大小/跌幅桶互斥，一个砸单只进入一个桶，避免同一事件因重叠Profile重复计算仓位。
- 每次新砸单都是新的lot；加仓是多个独立lot并存，而不是修改旧仓均价。
- 快速止盈只在入场后5秒内有效；未触发时继续使用移动止盈、可选固定止损和30秒/5分钟最长持仓。
- E0表示收到砸单后等待下一笔严格因果公开储备立即报价，不把已经执行的砸单成交当作本系统成交。
- 默认矩阵成本为每笔0.000005 SOL基础费、0.0001 SOL Priority Fee、0 Jito Tip，可分别用`SDBR_DUMP_MATRIX_*_FEE_SOL`覆盖。
- 旧的Same-Slot Shadow、Frozen Causal Backrun、N+1 Recovery、观察钱包和执行测速在生产配置中固定关闭，旧`.env`开关不能将它们重新启用。

## 直接砸单矩阵

信号分层：

| 桶 | 绝对卖出量 | 冲击跌幅 | 研究仓位 |
|---|---:|---:|---:|
| `DBM-S-D8/D15/D30` | 5–10 SOL | 8–15 / 15–30 / 30%+ | 1 SOL |
| `DBM-M-D8/D15/D30` | 10–25 SOL | 8–15 / 15–30 / 30%+ | 1 SOL |
| `DBM-L-D8/D15/D30` | 25+ SOL | 8–15 / 15–30 / 30%+ | 1 SOL |

全局最大记录跌幅默认为99%；超过40%的事件不再被采集层删除，而是进入`D30`桶并保留数据质量/毒性特征。

每个达标事件测试E0/E100/E300三种入场，以及36种快速止盈、移动止盈、最长持仓和固定止损组合。
退出条件触发后使用其后的第一笔可观察公开储备报价；超时独立记录为`NO_EXIT`，不会用最后价格伪造成交。

## 报价与费用口径

实现依据 Pump 官方资料：PumpSwap 是常数乘积 AMM；Quote 侧的有效储备为
`pool_quote_token_account.amount + virtual_quote_reserves`，其中 virtual 值是 signed `i128`。
解析器保留事件中的 LP、Protocol、Coin Creator、Cashback、Buyback 费率和原始数值。按官方 SDK，
可执行交易费只包含 LP、Protocol 与 Coin Creator；`buyback_fee_basis_points` 是费用分配比例，不能再作为
一笔额外交易费叠加。

- [PumpSwap 官方说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)
- [PumpSwap 官方 IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)
- [动态费用官方说明](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md)

直接矩阵版本为 `PUMPSWAP_DIRECT_DUMP_MANAGED_V2`：使用每笔事件的有效储备和可执行费率，再叠加配置的买卖滑点、
Priority Fee、Jito Tip 与基础交易费。入场前会在加入1 SOL买单后的反事实储备上计算立即卖回的SOL，默认拒绝即时净往返损失超过8%、买入或卖出流动性占用超过10%的仓位。它是事件流可实现性研究模型，不是链上 SDK 的逐指令报价替代品。

旧事件解析没有把多Token交易中的Token Account精确映射到各自PumpSwap事件，可能产生1000倍级价格异常。当前解析版本会标记到每个砸盘事件；程序启动时会删除旧策略派生行，并让Dashboard只读取直接矩阵报价模型。

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

上传包包含24小时窗口数据库、Schema、Manifest、Git提交号和逐文件SHA-256。覆盖率不会用首条到末条记录的简单跨度冒充；导出只报告研究数据状态，实盘决定始终为`TRADING_DISABLED`，最终仍需和另一不重合时间窗口交叉验证。上传主文件和校验文件后，
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

程序不再永久保存全部 PumpSwap 成交。Dump Detector 只在内存里保留检测所需的5秒历史；一旦识别到砸盘，才回填该池的砸盘前窗口，并继续保存直接矩阵入场和独立退出所使用的成交。结构化字段默认完整保留，重复的 `raw_json` 默认关闭。

事件窗口成交和 Slot 摘要默认保留30天，后台每10分钟分批清理；结构化研究结果不自动删除。每个达标砸单固定新增108条直接矩阵模拟，分别对应3种入场和36种独立退出配置。SQLite删除旧行后会复用空闲页，因此新库会稳定在有限大小，但旧的大文件需要一次性压缩迁移才能立即归还系统盘空间：

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
- `confirmations`：`DBM-*`直接砸单信号桶及其严格因果入场参考点。
- `same_slot_observations`、`same_slot_shadow_simulations`、`watched_wallet_trades`、`candidate_excluded_mints`：仅为旧Schema兼容保留，生产启动时清空且不再写入。
- `execution_probes`：候选首买到达热路径时，临时Keypair在本机真实完成构建、签名和序列化的耗时与负载大小；Slot结束后再校验触发交易是否确为最终链上Rank #1。发送开关受数据库约束只能为0，链上落地和排名明确记录为未发送/不可测。
- `simulations`：每个直接砸单信号桶、入场延迟和管理型退出组合的请求时间、实际报价时间、Fill、成本与收益；Dashboard只读取`PUMPSWAP_DIRECT_DUMP_MANAGED_V2`。
- `toxic_wallets`：只由已经结束的历史事件积累，供未来信号使用，避免前视偏差。

## 当前边界

- 默认`logs-status`模式用两条独立数据流按Signature合并：事件字段来自PumpSwap公开日志，严格排序来自LaserStream transaction status。它不接收完整交易元数据，首次看到每个池通常需要2次普通RPC读取；Dashboard会显示合并率、待合并消息、日志近似字节和RPC次数。Helius最终计费以控制台为准，程序显示的日志MB不包含协议开销。
- 切换`SDBR_STREAM_MODE=full-transactions`可恢复旧的完整交易流，便于紧急对照，但会恢复高额LaserStream流量。轻量与完整模式分别写入`ingestion_mode`，分析时不可把接收延迟直接混为同一基础设施样本。
- LaserStream 没有提供 `transactionIndex` 时，只能证明同 Slot 相关，不能证明严格执行顺序。
- 即使存在严格排序的同 Slot 后续买单，也只是已经执行交易的观察结果，不代表机器人可以回到该位置成交。
- 仅靠事件流无法可靠计算 Top Holder 或钱包关联集群；当前只支持信号前已知的 Creator、配置名单和历史毒性记录。
- 未使用 RPC 补历史池龄。进程启动前已经存在的池子以“已观察时长下限”表示，因此初期会保守地拒绝池龄门槛。
- 当前退出报价使用退出时观察到的公开池状态，没有把1 SOL模拟买入后的反事实储备逐笔重放；深度不足的池子可能因此产生偏差，
  对 5 SOL 影响更明显。V4 已在入场容量检查中正确更新一次买入后的储备，但持仓期间的后续公开成交仍未做完整反事实状态重放；实盘化前必须完成状态化回放。
- 本项目不包含实盘执行。样本达到分析门槛后，仍需按9个砸单桶、NO_EXIT全损、两个不重合时间窗口、最差5%和Exit Fill Rate进行人工评审；通过也只批准开发发送沙盒，不会自动投入SOL。

## 检查

```bash
pnpm check
pnpm test
```

测试覆盖有效储备、signed virtual reserve、逐笔费用、Token 精度、严格/相关 Slot 标签、
PumpSwap迁移后全网卖出监控、5 SOL/8%双门槛、9个互斥砸单桶、1 SOL独立加仓、E0/E100/E300入场、48种管理型组合、低Priority/Jito成本、发送硬关闭、异常储备隔离、NO_EXIT全损情景、SQLite批量写入和`NO_EXIT`独立统计。
