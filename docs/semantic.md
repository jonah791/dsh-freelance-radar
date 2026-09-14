# 语义文档：dsh-freelance-radar（自由职业任务雷达）

| 项 | 值 |
|----|----|
| 能力名 | dsh-freelance-radar（插件内 `name = 'freelance-radar'`；组合行 id `agent-freelance-radar`） |
| 主副本路径 | `self-plugins/dsh-freelance-radar/docs/semantic.md` |
| 实现落点 | `src/index.ts`（采集/存储/4 工具）、`src/scoring.ts`（纯逻辑：画像/打分/去重） |
| 版本 | v0.1.0（package.json） |
| 状态 | **draft**（补课文档，验收条目待线上复核） |
| 依赖服务 | `inject = ['tools']`；外部依赖：公网 HTTP（4 个远程任务源） |
| 数据落点 | `<DSH_HOME>/freelance-radar/jobs.json`（`DSH_HOME` 缺省 `~/.dsh`；本机 = `E:\alice\.dsh\freelance-radar\jobs.json`） |

---

## 1 · 定位与反定位

**定位**：支撑主人「自由人 / 数字游民」路线的**信息采集器**——聚合公开远程任务源 → 按主人能力画像（AI/Agent/LLM + 排除词）打分排序 →
工具面呈现高分清单与每日摘要。主人决策闭环：`radar_scan` 出清单 → `radar_mark` 留痕 → 推送/写 proposal 由爱丽丝自己做。

**反定位（本文不管什么）**：
- **不自动投标、不写回平台**（合规红线，源码注释与 README 均明示）——本插件只有**读**公开数据
- 不管推送投递（那属于 `dsh-agent-telegram`：`telegram_send`）——雷达只准备文案，发送归爱丽丝
- 不管简历/作品集/报价策略（人的决策面）
- **不是** 招聘数据库（只有 `jobs.json` 一个本地去重表，无全网索引）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 画像（profile） | `RadarProfile`：includeTags / includeKeywords / excludeKeywords / mismatchSignals / minScore / pages；可被 Config.profile 部分覆盖 |
| 指纹（fingerprint） | `source + '\|' + norm(title).slice(0,80)`——**去重唯一键**（不是源 id） |
| 状态机 | `new` → `considered` → `applied` / `ignored`（`ignored` 不进扫描候选） |
| excluded | 命中 `excludeKeywords` 的**硬过滤**（分数置 0，不参与排序） |
| mismatch | 命中 `mismatchSignals` = 技术栈提示，**不排除不降分**（仅显示 ⚠️栈） |
| 时效 | 新鲜度：≤3 天满分 15，≥14 天 0；待跟进：`considered` 且 `updatedAt` 距今 ≥3 天 |

## 3 · 概念模型

```
远程源（4 个，并行 allSettled）
  ├─ 电鸭 API   GET {eleduckApiBase}/posts?category=5&page=N     → fetchEleduck（≤2 页）
  ├─ RemoteOK   GET https://remoteok.com/api                     → fetchRemoteOK（跳过 [0] metadata + 技术岗正则过滤）
  ├─ Remotive   GET https://remotive.com/api/remote-jobs?limit=100 → fetchRemotive
  └─ WeWorkRemotely RSS  .../remote-programming-jobs.rss         → fetchWeWorkRemotely（正则解析 <item>）
        │  eleduckToJob / remoteOkToJob / remotiveToJob / 内联 → 统一 Job 结构
        ▼
  ingest(jobs)：loadState → 按 jobFingerprint 去重（已存在只更新 updatedAt）→ saveState
        ▼
  jobFingerprint + scoreJob(job, profile)：
        excludeKeywords 命中 → excluded（硬过滤）
        keyword(≤40，title 8/summary 4/tag 3) + tag(≤20，每个 6 分)
        + remote(15) + freshness(≤15) + quality(≤10)  → score
        + mismatch[]（提示）
        ▼
  radar_scan  top15  ┊  radar_list  过滤/排序  ┊  radar_mark  状态留痕  ┊  radar_digest  今日摘要
        ▼
  爱丽丝（主会话）：telegram_send 推送 / 写 proposal / 或忽略
```

不变量（invariants）：
1. **I1 只读采集**：本插件对远程平台只发 GET；全部写操作只在本地 `jobs.json`（可 grep 出唯一的 `writeFileSync` 在 `saveState`）。
2. **I2 指纹去重**：同一 `source+title(前 80 字符, 归一化)` 只入库一条——重复入库不会新增（`added` 不增）。
3. **I3 损坏即重置**：`jobs.json` 解析失败 → `loadState` 返回 `{jobs:[]}`（**丢弃坏文件，不备份**——见 §10 U3）。
4. **I4 写失败不致命**：`saveState` 的 `writeFileSync` 失败被 catch 且**不报错**（静默，见 §10 U4）。
5. **I5 工具数固定 4**：`radar_scan` / `radar_list` / `radar_mark` / `radar_digest`。
6. **I6 决策归爱丽丝**：插件无定时器、无自动推送、无自动投标——`ctx.effect` 内是空清理函数。

## 4 · 契约

### 4.1 配置（`Config` schema）
| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | **被消费**：4 个工具开头均 `if (!config.enabled) return {ok:false,error:'freelance-radar disabled'}` |
| `dataDir` | 无（缺省） | 空则用 `<DSH_HOME>/freelance-radar` |
| `eleduckApiBase` | `https://svc.eleduck.com/api/v1` | 电鸭 API 根 |
| `profile` | 无（`z.any()`） | `Partial<RadarProfile>`，浅合并进 `DEFAULT_PROFILE` |
| `rssSources` | 无 | **声明但未被消费**（RSS 源在代码里硬编码） |

### 4.2 打分契约（`scoring.ts`，逐字）
| 维度 | 上限 | 规则 |
|------|------|------|
| keyword | 40 | 每个 includeKeyword：title 命中 +8 / summary 命中 +4 / tag 命中 +3（单选其一，优先级由上到下） |
| tag | 20 | 每个 tag 命中任一 includeTag +6（内层 `break` 防重复），合计封顶 20 |
| remote | 15 | 任一 tag 匹配 `/远程\|兼职\|remote\|part-?time/i` → 15 |
| freshness | 15 | `daysSince ≤3 → 15`；`≥14 → 0`；之间 `round(15*(1-(d-3)/11))` |
| quality | 10 | 未关闭 +3；`content.length > 200` +4；`summary.length > 50` +3（封顶 10） |
| 硬过滤 | — | `excludeKeywords` 命中任一 → `excluded:true, score:0` |
| mismatch | — | 命中 `mismatchSignals` → `mismatch[]`（**不降分**） |

`DEFAULT_PROFILE` 关键值（逐字）：`title='AI Agent / LLM 应用定制工程师'`、`minScore=60`、`pages=5`；
`excludeKeywords=['区块链','web3','币圈','虚拟币','博彩','刷单','灰产','加密货币','token 众筹','刷量']`；
`mismatchSignals=['n8n','wordpress','php','java','c#','.net','unity','flutter','react native','小程序原生','django','ruby','golang','lua']`。

### 4.3 状态→裁决表
| 输入状态 | 裁决 | 依据 |
|---------|------|------|
| `radar_scan` 且 `enabled=false` | `{ok:false,error:'freelance-radar disabled'}` | 显式闸门 |
| 某源请求失败/超时(20s) | 该源返回 `[]`（`fetchJson` catch → null），其余源照常 | 部分失败不拖垮整体 |
| `radar_scan` | 只把 `status!=='ignored' && closed!==true` 的任务纳入排序，返回 top **15** | `scanAll` 过滤 + `slice(0,15)` |
| `radar_list` 带 `minScore` | 先实时打分再按 `lastScore>=minScore` 过滤；**不排序**（保持库内顺序） | 与不带 minScore 分支行为不同 |
| `radar_list` 不带 `minScore` | 排序：状态序 `new(0)<considered(1)<applied(2)<ignored(3)`，同状态内分数降序 | `order` 表 |
| `radar_list` `limit` | 夹在 `[1,100]`，缺省 20 | 参数夹取 |
| `radar_mark` 找不到 `jobId` | `{ok:false,error:'job <id> 不存在（先 radar_scan 采集）'}` | 显式校验 |
| `radar_mark` 成功 | 改 `status`/`updatedAt`，可选写 `note`，落盘 | 主人决策留痕 |
| `radar_digest` 高分新任务 | `status==='new'` **且** `firstSeenAt` 的日期 == 今天（UTC）**且** 实时分 ≥ minScore → 取前 5 | 摘要口径 |
| `radar_digest` 待跟进 | `status==='considered'` 且 `updatedAt` 距今 `≥3` 整天 → 取前 5 | 跟进提醒 |
| 两者皆空 | 正文输出「雷达平静」+ summary 仍带「雷达正常巡检」 | 不静默 |

### 4.4 调用点清单 `[MUST]`
| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml` 行 `id: agent-freelance-radar` / `name: dsh-freelance-radar`（无 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:apply` → `ctx.tools.register(defineTool({name:'radar_scan'…}))` / `'radar_list'` / `'radar_mark'` / `'radar_digest'` | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 内 `mkdirSync(dataDir, {recursive:true})` | 挂载时（失败延后到写时重试） |
| 插件本体 | `src/index.ts:apply` 末尾 `logger.info('ready (dataDir=…, eleduck=…, profile=…, minScore=…)')` | 挂载时（**logger 不落盘，非证据**） |
| `radar_scan` | `src/index.ts:scanAll` → `fetchAllSources` → `fetchEleduck`/`fetchRemoteOK`/`fetchRemotive`/`fetchWeWorkRemotely` → `ingest` → `loadState` → `rankJobs` | 每次调用 |
| 全部工具 | `src/scoring.ts:scoreJob` / `rankJobs` / `jobFingerprint` / `daysSince` / `freshnessScore` | 打分/排序/去重时 |
| 存储 | `src/index.ts:loadState` / `saveState` → `<dataDir>/jobs.json`（`JSON.stringify(state,null,2)`） | 读：每次工具调用；写：`ingest`/`radar_mark` |
| 模型（爱丽丝） | 感知圈/巡检：`radar_digest` → 需要时 `telegram_send` 给主人 | 每日/自主巡检 |
| 模型（爱丽丝） | 决策链：`radar_scan` → `radar_list` → `radar_mark(considered/applied/ignored)` | 主人决定时 |
| 运行时数据（实测 2026-09-14） | `<DSH_HOME>/freelance-radar/jobs.json` = **298 KB**，mtime **2026-09-05 18:04** → 即「雷达自 09-05 后未再扫描」（库内是历史任务快照） | 现状快照 |

### 4.5 观测轨迹契约（S4 证据层 · 2026-09-14）

**落盘路径（单一真源）**：`<DSH_HOME>/freelance-radar-trace.jsonl`——`DSH_HOME` 由 `src/trace.ts:resolveHome()`（环境变量 → 回退 `<homedir>/.dsh`）解析，`radarTracePath(home)` 是唯一文件名来源。一行一阶段（单行 JSON，可 `tail`/`grep`），追加写，无轮转。开关 `DSH_RADAR_TRACE=0`（缺省开启）。**与业务落库分离**：`jobs.json` 是数据，轨迹是证据（前者坏了重置、后者坏了只丢证据）。

**阶段枚举**：`boot`（`apply` 一行：enabled/dataDir/apiBase/源清单/pages/minScore）｜`scan/start`（一轮扫描开始）｜`source/end`（某源成功，**每个源一行**）｜`source/error`（某源失败/抛错，**每个源一行**）｜`scan/end`（本轮收尾：抓取/新增/重复/在库/源成败计数）。

**核心不变式（MUST）**：`SOURCE_NAMES`（4 源）有几条，本轮 `source/*` 行就**必须**有几条——任何源失败（含 `Promise.allSettled` 的 rejected）都**必有一行**。这条不变式由 `traceSourceReport()` 单一函数收口，并由接线测试断言（A16/A18）。它的价值来自真事故：脏日期 `RangeError` 曾让**整源被 `if (r.status === 'fulfilled')` 静默丢弃**，外部表现为「今天没新任务」。

**行 schema**（键序固定，可选字段按序前插）：

| 字段 | 语义 | 五问 |
|------|------|------|
| `atMs` / `pid` / `build` | 写入时刻 / 进程 pid / `<version>@<lib/trace.js mtime ms>` | Q1 |
| `source` | 源名（`eleduck`/`remoteok`/`remotive`/`wwr`）；`scan/*`、`boot` 行省略 | Q2 |
| `phase` / `failure?` / `error?` | 阶段枚举 / 失败分类（`http-4xx`\|`http-5xx`\|`dns`\|`refused`\|`timeout`\|`network`\|`parse`\|`abort`\|`unknown`）/ 原文裁剪 200 字符 | Q3 |
| `raw` / `hits` / `dropped` / `reasons?` | 源原始条数 / 清洗后条数 / 丢弃总数 / **丢弃依据**（键：`bad-entry`\|`duplicate`\|`non-tech`\|`metadata`\|`bad-item`\|`empty`） | Q4 |
| `fetched` / `added` / `dups` / `live` / `sourcesOk` / `sourcesFailed` | 仅 `scan/end`：本轮抓取 / 新入库 / 已存在跳过 / 在库 / 成功源数 / 失败源数 | Q4 |
| `durationMs` | 阶段耗时（每源实耗 / 整轮实耗；`scan/start` = 0） | Q5 |
| `cfg?` | 仅 `boot` | Q1 |

**判读口诀（Q4）**：`added == 0` 且 `sourcesFailed == 0` ⇒ **真的没新任务**；`sourcesFailed > 0` ⇒ **有源挂了**（再看该源那行的 `failure`/`error`）；`dups == fetched` ⇒ 数据没变（不是没抓）。

**隐私不变量（MUST）**：轨迹只记**计数与源名**——任务标题/正文/URL **不落盘**（正文可能含联系方式等个人信息，落库路径 `jobs.json` 由业务负责）；`boot` 只记白名单配置字段，**不记 `profile` 全文**。

**行为中立（2026-09-14 显式声明）**：本次**不改采集行为**——失败源仍贡献 0 条（与旧实现一致），`fetchJson/fetchText` 改成「可判别结果」只影响**是否留痕**，不影响喂给 `ingest` 的任务集合（唯一例外见 §9：`null` 元素仍会抛，与旧实现逐字一致，只是现在**有行可见**）。

**调用点清单（MUST）**：

| 调用点（文件:符号） | 阶段 | 内容 |
|---|---|---|
| `src/index.ts:apply` → `radarTraceBoot({enabled,dataDir,eleduckApiBase,sources,pages,minScore})` | `boot` | 生效面自报（一次装载一行） |
| `src/index.ts:scanAll` → `radarTrace({phase:'scan/start'})` / `{phase:'scan/end',…}` | `scan/start` / `scan/end` | 一轮扫描的头尾（含入库闭环计数） |
| `src/index.ts:scanAll` → 遍历 `reports` 调 `traceSourceReport(report)`（**唯一逐源落笔点**） | `source/end` / `source/error` | 每源一行 |
| `src/index.ts:fetchAllSources` → `runOne(name, fn)` | — | 逐源兜错 + 计时，把「源抛错」变成一条报告 |
| `src/index.ts:fetchJson/fetchText` → `fetchRaw(url, timeoutMs, take)` | — | HTTP/网络失败 → `{ok:false, failure, error}`（不再吞成 `null`） |
| `src/sources.ts:parse*Detailed` → `stats` | — | 四个解析器带出 `raw/kept/dropped/reasons`；原名函数为薄委托（行为逐字一致） |
| `src/trace.ts:finalizeStats/addReason/mergeStats` ← `fetchEleduck` | — | 跨页去重后 `kept` 以最终产出为准、丢弃依据相加 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件会**主动出网**（4 个域名）并把摘要写入本地 JSON。它**不**校验抓到的内容（陌生 HTML → `stripHtml` 粗去标签，可能残留脚本文本），也不做输入转义。
- 不越界清单：不登录、不带凭据、不提交表单；不自动投标；不发消息；不抓付费/私有接口。
- 失败面：
  - 网络失败 → 各 `fetch*` 记录 `{ok:false, failure, error}` 并返回 0 条（**放行 + 静默降级**，`radar_scan` 仍 `ok:true`）；**「源全挂」与「今日无任务」在返回值上仍难区分，但在轨迹上一眼可分**（§4.5：`sourcesFailed` vs `added=0`）。
  - 源抛错（如脏元素 `null` → TypeError）→ 旧实现被 `Promise.allSettled` 静默丢弃；现同样不贡献任务，但**必留一行 `source/error`**。
  - 存储损坏 → `loadState` catch → 重置为空（**丢弃**，不备份）。
  - 存储写失败 → `saveState` catch → 静默（**不报错**）。
  - 轨迹写失败 → `radarTrace` 吞错返回 `false`（**不影响扫描**，见 A20）。
  - 缺 `HOME` 之类环境问题 → `dshHome()` 用 `homedir()` 兜底。

## 6 · 与既有机制的关系

- 与 **AGENTS.md §5.22（机制自证）**：本能力**有落盘产物**（`jobs.json` 含 `firstSeenAt/updatedAt/status/note`），可直接 `tail`/`jq` 观察；**并有 sidecar 轨迹**（`<DSH_HOME>/freelance-radar-trace.jsonl`：每源一行 + 每轮收尾，见 §4.5）——「抓了哪些源、各源几条、失败了几条、丢了多少脏数据」从此可一条 `tail` 回答。
- 与 **`dsh-agent-telegram`**：分工 = 雷达准备文案、爱丽丝调 `telegram_send` 发送（推送到主人频道）。
- 与 **`dsh-agent-memory`**：雷达状态在 `jobs.json`（结构化），不写记忆库——「发生过什么」可选进记忆，但雷达本身不自动写。
- 与 **§5.11（组合变更必验证）**：改 `src/*.ts` → `pnpm build`（`tsc -p tsconfig.json`）→ 预检看到 `lib/` mtime 前进。
- 与**主人自由人路线**：本插件是**信号源**，不是决策者（§2.1「机制把信号送达，不代替决策」）。

**生效判据（改代码后怎么证明真的生效）**：
1. 构建产物新：`self-plugins/dsh-freelance-radar/lib/index.js` 与 `lib/scoring.js` 的 mtime **晚于**当前 web 进程启动时间。
2. 工具面在场：本会话可列出 4 个 `radar_*` 工具。
3. 行为可答：`radar_scan` 返回 `ok:true` 且 `total>0`（本机 `jobs.json` 已有历史任务），`added` 可为 0。
4. 落盘产物：调用后 `<DSH_HOME>/freelance-radar/jobs.json` 的 **mtime 前进**且 JSON 可解析（这是唯一不依赖内存的物证）。
5. 打分自证：对同一 job 连续调 `radar_list minScore=X` 取不同 X，`lastScore` 稳定不跳变（说明 `scoreJob` 无隐式状态）。
6. **证据层自证（2026-09-14 新增）**：一轮 `radar_scan` 后 `tail -6 "$DSH_HOME/freelance-radar-trace.jsonl"` 出现 `scan/start` + **4 行 `source/*`（源名各异）** + `scan/end`，且 `scan/end.build` 的 mtime 段 == `stat -c %Y lib/trace.js`×1000。
7. **一命令判读（Q4 口诀）**：`tail -1 … | grep '"phase":"scan/end"'` → `sourcesFailed>0` ⇒ 有源挂了；`sourcesFailed=0 且 added=0` ⇒ 真没新任务。

**回退**：`git revert` 最近提交 → `pnpm build` → 预检 → 哨兵重启 web。**只关证据层**：`DSH_RADAR_TRACE=0`（不触业务代码）。
**数据面回退**：`jobs.json` 是纯本地状态，备份/还原该文件即可（`status`/`note` 全部在里面）；代码回退**不会**破坏已有状态（`loadState` 对未知字段宽容）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰好 4 个 `radar_*` | `grep -c "name: 'radar_" src/index.ts` = 4 | 待验收 |
| A2 | 只读采集（无写回平台） | `grep -nE "method: 'POST'\|body:" src/index.ts` 无命中 | 待验收 |
| A3 | 指纹去重生效 | 连调两次 `radar_scan`，第二次 `added == 0`（无新任务时） | 待验收 |
| A4 | 排除词硬过滤 | 造一条含「web3」的 job 进 `jobs.json` → `radar_list` 该条 `excluded:true, lastScore:0` | 待验收 |
| A5 | 打分上限正确 | 构造 keyword 全命中的 job → `breakdown.keyword <= 40`（同理 tag≤20/quality≤10） | 待验收 |
| A6 | freshness 边界 | `daysSince=3 → 15`；`=14 → 0`；`=8.5 → 8`——**已由单测锁住**：`tests/scoring.test.mjs`「阈值边界」+ 单调不增断言 | ✅ 2026-09-14 |
| A7 | disabled 闸门 | 配置 `enabled=false` 后 `radar_scan` → `ok:false` + `freelance-radar disabled` | 待验收 |
| A8 | mark 落盘可复用 | `radar_mark status=considered` → 读 `jobs.json` 该条 `status/updatedAt` 已变 | 待验收 |
| A9 | digest 跟进口径 | 把某条 `considered` 的 `updatedAt` 改成 4 天前 → `radar_digest.pendingFollowups` 含它 | 待验收 |
| A10 | 坏 JSON 不崩 | 把 `jobs.json` 写成 `{bad` → `radar_list` 返回 `ok:true, total:0`（重置而非抛错） | 待验收 |
| A11 | 回归能力存在且绿 | `npm test`（= `node --test "tests/*.test.mjs"`，跑 `lib/` 产物）→ **36 pass / 0 fail** | ✅ 2026-09-14 |
| A12 | 打分纯逻辑失败/退化路径被锁住 | `tests/scoring.test.mjs`：非法 ISO→999、未来时间夹到 0、空画像/空 tags 不抛、封顶 40/20、幂等 | ✅ 2026-09-14 |
| A13 | 源解析器对脏数据保守返回（不抛） | `tests/sources.test.mjs`：缺 id/title、类型不符、空标题→`null`；列表级坏条目跳过；空数组→`[]` | ✅ 2026-09-14 |
| A14 | **脏日期不再拖垮整源**（本次修掉的真缺陷） | `node --test tests/sources.test.mjs` 三条「非法日期不得抛错」（remoteok/remotive/wwr）转绿；修复前是 `RangeError: Invalid time value` | ✅ 2026-09-14 |
| A15 | 解析层零 IO（可离线跑） | `tests/*.test.mjs` 全程无 fetch/fs 调用（纯函数；`Date` 仅用于缺失日期回落） | ✅ 2026-09-14 |
| A16 | **每源必有一行**（§4.5 核心不变式） | 一轮 `radar_scan` → `grep -c '"source":"' "$DSH_HOME/freelance-radar-trace.jsonl"` = 源数 × 轮数；接线测试断言 4 源 4 行（含 1 源失败时仍 4 行） | ✅ 2026-09-14（接线用例） |
| A17 | **「源挂了」与「没新任务」可分**（原缺陷面） | 一轮扫描后 `tail -6`：`scan/end` 行 `sourcesFailed: 1` + 该源 `source/error`（`failure:'http-5xx'`, `error:'HTTP 503'`）；对照：`added=0` 且 `sourcesFailed=0` = 真没新任务 | ✅ 单测级已实测；**线上待验收**（部署后 tail 真实文件） |
| A18 | **整源静默消失不再可能** | 源返回 `null` 元素（旧实现 TypeError → allSettled 静默丢源）→ 现在留下 `source/error`（`error` 含 `null`），其余 3 源照常入库 | ✅ 2026-09-14 |
| A19 | 脏数据丢弃数与依据可读 | `source/end` 行 `raw/hits/dropped/reasons`（如 `{raw:3,hits:1,dropped:2,reasons:{'bad-entry':2}}`）；四个 `parse*Detailed` 的 `reasons` 键枚举见 §4.5 | ✅ 2026-09-14 |
| A20 | **观测不反噬**（含接线级尸体测试） | `DSH_HOME` 父路径是普通文件 → `radarTrace` 返回 `false` 且不抛；`radar_scan` 照常 `ok:true` 且 `added` 不变 | ✅ 2026-09-14 |
| A21 | 入库闭环可解释（`scan/end`） | 首轮 `fetched=added=5, dups=0`；第二轮同数据 `added=0, dups=5, sourcesFailed=0` | ✅ 2026-09-14 |
| A22 | **搬家零漂移（机械核对）** | HEAD 版 `sources.ts`（node 类型剥离直跑）与 `lib/sources.js` 在 **17 组输入**（含 `null` 元素、脏日期、重复 id、空 XML）上结果（含抛错类型）逐字相同 → `对比次数=17 不等价=0` | ✅ 2026-09-14 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（4 源网络采集 + 存储 + 4 工具 + **`runOne`/`scanAll` 观测接线**）、`src/scoring.ts`（189 行纯逻辑，**零 IO**）、
  `src/sources.ts`（数据源解析层，**零 IO**——2026-09-14 从 `index.ts` 抽出，见 §9；同日新增 4 个 `parse*Detailed` 统计出口，原名函数为薄委托）、
  `src/trace.ts`（**观测层纯函数 + 薄 IO**：`resolveHome`/`radarTracePath`/`selfBuild`/`classifyFailure`/`clip`/`mergeStats`/`finalizeStats`/`addReason`/`emptyStats`/`serializeTraceEntry`/`parseTraceEntries`/`readTraceEntries`/`appendTraceEntry`/`radarTrace`/`traceSourceReport`/`radarTraceBoot`/`traceEnabled`）。
- 测试：`tests/scoring.test.mjs`（打分/新鲜度/排名/指纹）+ `tests/sources.test.mjs`（4 源解析器）+
  `tests/trace.test.mjs`（**25 用例**：统计纯函数/序列化/落盘/尸体测试/每源必有行/**接线测试**——真 `apply` + 假 ctx + fetch 桩），
  `npm test` 跑 `lib/` 产物（与运行时同源）→ **61 pass / 0 fail**（2026-09-14）。
- 同语义副本：无。
- 未实现/未验证部分**显式标注**：
  - ~~**无 `tests/`**：A1–A10 全部待验收。~~ 已补（A11–A15 已验证）；A1–A5/A7–A10 属**接线/线上**行为，仍需真实调用验收（不属离线单测面）。
  - `TECH_RE`（RemoteOK 技术岗过滤）是**无词界子串匹配**：`'ai'` 会命中 `"mAIntenance"`、`'dev'` 会命中 `"devops"` 之外的各种词——已知**过滤过宽**（噪音岗漏网），单测已把该真实语义锁住（`tests/sources.test.mjs` + `tests/trace.test.mjs` 的「Hotel Maintenance Technician 被保留」样本），收紧会改筛选行为故未改，见 §10 U7。
  - `radar_mark` 的 description 提到「可用 **`radar_find`** 查」——**该工具不存在**（实际只有 4 个工具）；文案与工具面不一致。
  - `radar_scan` 的 `push` 参数**未被 `execute` 消费**（`args` 未读 push；render 也无分支），描述与实际行为不符。
  - `Config.rssSources` **未被消费**；`RadarProfile.pages` 默认 5，但 `fetchEleduck` 内 `if (page >= 2) break` 使电鸭**最多只抓 2 页**。
  - README 与源码头部引用的设计文档 `docs/freelance-radar-design.md` 在本仓库中**不存在**（`scoring.ts` 头部仍指向它）。
  - README 写「v1 = 电鸭 API（+RSS 预留）」，实现已接入 4 源（电鸭/RemoteOK/Remotive/WWR）。

## 9 · 实践修订记录

- **2026-09-14 验收复跑抓到「非确定性测试」（可维护性补课的交付缺陷）**
  - 症状：S4 批次自报 `61/61 全绿`，派发者独立复跑得到 `60/61`；连跑 8 轮有 1 轮红。**一条会随机红的套件，「全绿」这个结论本身就不可信。**
  - 根因（同类形状**共 4 处**）：测试用「同一解析函数调两次、整对象 `deepEqual`」断言薄委托，而 fixture 的条目**没有日期** ⇒ `toIso` 兜底取**当前时间** ⇒ 两次调用天然差毫秒（实测 `…53.683Z` vs `…53.682Z`）。
  - 修法：① 四条断言改为**比结构**（同 id 序列 / 同条数 / 同 url 集合）——它们真正要断言的正是「薄委托」，不是「两次调用的当前时间相等」；② `toIso(v, now = Date.now())` **时钟可注入**（默认值保持生产行为逐字不变），并新增一条确定性单测把兜底语义钉死。
  - 验证：连跑 **20 轮 0 失败**（此前 8 轮 1 失败、15 轮内必现）。
  - 教训（回写技能 `plugin-maintainability` 缺陷形状库 **D8 非确定性断言**）：
    ① **实现有「取当前时间」的兜底 ⇒ 任何涉及该字段的整对象比对都是定时炸弹**；
    ② 断言要写**意图**——"薄委托"= 结构相同，不是"逐位相同"；
    ③ **交付前必须连跑多轮**（单轮绿不能证明套件确定）；④ 自报绿 ≠ 真绿，**独立复跑是硬要求**。

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：只读采集 / 指纹去重 / 状态机 new→considered→applied|ignored / 决策归爱丽丝（无定时器、无自动推送）。
  - 语义**被补充**：6 源采集实况（4 源已接入，README 与实现有落差）、`jobs.json` 的完整字段（`firstSeenAt/updatedAt/note`）、打分上限与边界值。
  - 语义**被修正**：`radar_mark` 描述里的 `radar_find` 是**不存在的工具**；`push` 参数声明但未消费——本文以实现为准，并把差异列入 §8/§10。
  - 教训：文档引用的**外部工具名**也算契约面——描述里出现一个不存在的工具名，会让下一个读者（尤其压缩后的我）调用失败后才反查。语义文档必须列调用点清单与真实工具面。

- **2026-09-14 可维护性补课（批次 W3）：解析层抽纯 + 测试 + 修脏日期缺陷**
  - 语义**被确认**（原以为要改、实测符合预期）：解析器对缺字段/类型不符一律保守返回 `null`，不抛错。
  - 语义**被补充**：`stripHtml / eleduckToJob / remoteOkToJob / remotiveToJob` 原困在 `index.ts`（与 fetch/存储混写）→ **仅搬家**到新模块 `src/sources.ts`；三个列表级清洗循环（eleduck/remoteok/remotive/wwr）从 `fetch*` 内抽出为 `parseEleduckPosts / parseRemoteOk / parseRemotive / parseWwrRss`（IO 留在 `index.ts`）。跨页去重（电鸭 `seen`）**保持在 `fetchEleduck`**，未下移到页面级解析器——避免丢跨页去重语义。
  - 语义**被修正（真缺陷，先证伪后修）**：`remoteOkToJob / remotiveToJob / parseWwrRss` 原写 `new Date(v).toISOString()`，**非法日期抛 `RangeError: Invalid time value`**；而三处调用都在 `Promise.allSettled` 里 → 该源整体记为 rejected 被丢弃 → **一条脏日期条目静默清空一整个源**（表现＝「今天没新任务」，与 U1 同形）。修法：新增纯函数 `toIso(v)`，非法/缺失一律回落当前时间（与「日期缺失」既有语义一致）；只改崩溃路径，正常日期行为逐字不变。
  - 语义**被修正（预期写错，不是代码错）**：`remotiveToJob` 的 `title` 是**先 trim 再拼 company**（`' Dev '` → `'Dev @ ACME'`）；`scoreJob` 的 `keyword` 分是**逐条关键词累加**（`'AI Agent 工程师'` 只命中 2 条 = 16 分，不是封顶 40）。两处按真实语义改写测试预期并加注释。
  - 教训：**「解析器不抛」这类不变量只有跑脏数据才暴露**——原实现路径上「日期字段缺失」有回落、`日期非法` 没有，差一个字符，线上表现却是整源静默消失。

### 2026-09-14 可维护性补课（批次 S4-C）：扫描轨迹证据层 + 25 测试

- 语义**被补充**：新增 §4.5「观测轨迹契约」——落盘路径 `<DSH_HOME>/freelance-radar-trace.jsonl`、阶段枚举 `boot`/`scan/start`/`source/end`/`source/error`/`scan/end`、行 schema、**每源必有行的不变式**、判读口诀、隐私不变量、调用点清单。
- 语义**被修正（上一轮修复的「另一半」）**：W3 修掉了脏日期的 `RangeError`，但**结构性静默仍在**——`Promise.allSettled` + `if (r.status === 'fulfilled')` 意味着**任何**源抛错仍会无声消失；`fetchJson/fetchText` 把 HTTP 失败吞成 `null` ⇒「源挂了」与「没新任务」在输出上同形。本次把这条链路变成可判别 + 必留痕（`source/error` + `sourcesFailed`），**采集行为不变**。
- 语义**被补充（真语义，与上一轮测试记录一致但更完整）**：`parseEleduckPosts([null])` **会抛 TypeError**（`p.id` on `null`）——这不是本次引入的（机械核对证明新旧同抛），是 D4 类「脏数据不设防」。区别在于：旧实现里它等于整源消失，现在**留一行 `source/error`**（failure 分类为 `unknown`，因为 TypeError 文案无可分类特征）。列为 U8。
- 语义**被补充（零漂移的机械证据）**：四个 `parse*` 逻辑搬进 `*Detailed` 后原名函数成薄委托；用 **HEAD 版 `sources.ts`（node 类型剥离直跑）与 `lib/sources.js` 在同一批输入上比对结果（含抛错类型）**——17 组 0 差异（A22）。第一版脚本因「旧实现抛错」直接崩掉，恰好证明了这条路径的存在——**把崩溃当成一种结果来比较**才对。
- 教训：**`Promise.allSettled` 的 `fulfilled` 过滤是静默数据丢失的常见形状**——它的语义是「我不在乎哪个源失败」，而运维的语义是「我必须知道哪个源失败」。两者不冲突的解法不是改控制流，而是**给每个 settle 结果一条留痕**。

## 10 · 未决问题

- **U1 源全挂 vs 今日无任务不可区分**：`fetch*` 失败一律返回 `[]`，`radar_scan` 仍 `ok:true`。倾向：加 `sources: {eleduck: n, remoteok: n, remotive: n, wwr: n}` 与 `failedSources[]` 回传。
  → **部分闭环（2026-09-14 S4-C）**：**轨迹侧已可区分**（`source/error` 行 + `scan/end.sourcesFailed`，见 §4.5/A17）；**工具返回值侧仍未回传**（属模型可见行为变更，本次不改）。
- **U8 `parseEleduckPosts([null])` 抛 TypeError（D4 脏数据不设防，S4-C 登记，未改）**：机械核对证明新旧同抛（非本次引入）。后果：旧实现里整源静默消失；现在留一行 `source/error`（`failure:'unknown'`）。倾向：与 W3 的 `toIso` 同类修法——转换器入口加 `if (p === null || typeof p !== 'object') return null`（需显式批准，属行为变更：脏元素从「炸整源」变为「跳过该条」）。
- **U9 轨迹文件无轮转**（2026-09-14 S4-C 新增）：`<DSH_HOME>/freelance-radar-trace.jsonl` 追加写、无上限。粗算每轮 ~6 行 × ~300B；按日巡检量级可忽略，但长期仍需有界裁剪（同其它 `*-trace.jsonl` 现状）。
- **U10 线上轨迹验收未做**（2026-09-14 S4-C）：A17 的「线上」一半要等部署 + 重启后 `tail` 真实文件才能标 ✅（本批次不部署，派发纪律）。
- **U2 `radar_find` 幻影工具**：描述让读者去调一个不存在的工具。倾向：改为「用 `radar_list` 看 id」或真的实现 `radar_find`（按标题模糊查）。
- **U3 坏状态文件直接丢弃**：`loadState` 解析失败即重置，历史去重表蒸发。倾向：改为「重命名为 `jobs.json.corrupt-<ts>` + 落 issue」，符合「不许静默」。
- **U4 `saveState` 静默失败**：写盘失败被吞，表现为「标记成功但重启即失」。倾向：返回 bool 并在工具结果里带 `persisted:false`。
- **U5 `pages` 与 `page>=2 break` 冲突**：配置项形同虚设。倾向：删 `pages` 或让它真正生效（需先评估电鸭限流）。
- **U6 `Config.profile` 用 `z.any()`**：无 schema 校验，错误画像（如 `minScore:'60'` 字符串）会静默生效。倾向：改为 `z.object(...).required(false)` 的显式 schema。
- **U7 `TECH_RE` 过滤过宽（本次登记，未改）**：无词界子串匹配 → `'ai'` 命中 `"mAIntenance"`、`'ml'`/`'dev'` 同理，非技术岗漏网（与注释「减噪音」的意图相反）。倾向：改词界匹配 `\b(...)\b` 并加回归样本；属**筛选行为变更**，需先评估召回损失（收紧可能误杀 `OpenAI`/`LLM` 类无词界写法）。
- **U1 补充（2026-09-14）**：本次已修掉其中一条**确定性**成因（脏日期 → 整源 rejected）。剩余成因（真实网络失败、源改版）仍不可区分，方案不变。
- **U3/U4 状态与本次测试的关系**：`loadState`/`saveState` 的失败路径**仍无测试**——它们碰 IO，需先抽成「以注入的读写函数为参数」的纯状态机方可离线断言（本次未做，产能优先级低于解析层）。
