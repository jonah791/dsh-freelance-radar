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

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件会**主动出网**（4 个域名）并把摘要写入本地 JSON。它**不**校验抓到的内容（陌生 HTML → `stripHtml` 粗去标签，可能残留脚本文本），也不做输入转义。
- 不越界清单：不登录、不带凭据、不提交表单；不自动投标；不发消息；不抓付费/私有接口。
- 失败面：
  - 网络失败 → 各 `fetch*` 内部 catch → 返回 `[]`（**放行 + 静默降级**，`radar_scan` 仍 `ok:true`）；这意味着「源全挂」与「今日无任务」在返回值上难区分（见 §10 U1）。
  - 存储损坏 → `loadState` catch → 重置为空（**丢弃**，不备份）。
  - 存储写失败 → `saveState` catch → 静默（**不报错**）。
  - 缺 `HOME` 之类环境问题 → `dshHome()` 用 `homedir()` 兜底。

## 6 · 与既有机制的关系

- 与 **AGENTS.md §5.22（机制自证）**：本能力**有落盘产物**（`jobs.json` 含 `firstSeenAt/updatedAt/status/note`），可直接 `tail`/`jq` 观察；但**无 sidecar 轨迹**（抓了哪些源、各源几条、失败了几条 → 未落盘）。
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

**回退**：`git revert` 最近提交 → `pnpm build` → 预检 → 哨兵重启 web。
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

## 8 · 与实现的关系

- 主实现：`src/index.ts`（4 源网络采集 + 存储 + 4 工具）、`src/scoring.ts`（189 行纯逻辑，**零 IO**）、
  `src/sources.ts`（数据源解析层，**零 IO**——2026-09-14 从 `index.ts` 抽出，见 §9）。
- 测试：`tests/scoring.test.mjs`（打分/新鲜度/排名/指纹）+ `tests/sources.test.mjs`（4 源解析器），
  `npm test` 跑 `lib/` 产物（与运行时同源）。
- 同语义副本：无。
- 未实现/未验证部分**显式标注**：
  - ~~**无 `tests/`**：A1–A10 全部待验收。~~ 已补（A11–A15 已验证）；A1–A5/A7–A10 属**接线/线上**行为，仍需真实调用验收（不属离线单测面）。
  - `TECH_RE`（RemoteOK 技术岗过滤）是**无词界子串匹配**：`'ai'` 会命中 `"mAIntenance"`、`'dev'` 会命中 `"devops"` 之外的各种词——已知**过滤过宽**（噪音岗漏网），单测已把该真实语义锁住（`tests/sources.test.mjs`），收紧会改筛选行为故未改，见 §10 U7。
  - `radar_mark` 的 description 提到「可用 **`radar_find`** 查」——**该工具不存在**（实际只有 4 个工具）；文案与工具面不一致。
  - `radar_scan` 的 `push` 参数**未被 `execute` 消费**（`args` 未读 push；render 也无分支），描述与实际行为不符。
  - `Config.rssSources` **未被消费**；`RadarProfile.pages` 默认 5，但 `fetchEleduck` 内 `if (page >= 2) break` 使电鸭**最多只抓 2 页**。
  - README 与源码头部引用的设计文档 `docs/freelance-radar-design.md` 在本仓库中**不存在**（`scoring.ts` 头部仍指向它）。
  - README 写「v1 = 电鸭 API（+RSS 预留）」，实现已接入 4 源（电鸭/RemoteOK/Remotive/WWR）。

## 9 · 实践修订记录

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

## 10 · 未决问题

- **U1 源全挂 vs 今日无任务不可区分**：`fetch*` 失败一律返回 `[]`，`radar_scan` 仍 `ok:true`。倾向：加 `sources: {eleduck: n, remoteok: n, remotive: n, wwr: n}` 与 `failedSources[]` 回传。
- **U2 `radar_find` 幻影工具**：描述让读者去调一个不存在的工具。倾向：改为「用 `radar_list` 看 id」或真的实现 `radar_find`（按标题模糊查）。
- **U3 坏状态文件直接丢弃**：`loadState` 解析失败即重置，历史去重表蒸发。倾向：改为「重命名为 `jobs.json.corrupt-<ts>` + 落 issue」，符合「不许静默」。
- **U4 `saveState` 静默失败**：写盘失败被吞，表现为「标记成功但重启即失」。倾向：返回 bool 并在工具结果里带 `persisted:false`。
- **U5 `pages` 与 `page>=2 break` 冲突**：配置项形同虚设。倾向：删 `pages` 或让它真正生效（需先评估电鸭限流）。
- **U6 `Config.profile` 用 `z.any()`**：无 schema 校验，错误画像（如 `minScore:'60'` 字符串）会静默生效。倾向：改为 `z.object(...).required(false)` 的显式 schema。
- **U7 `TECH_RE` 过滤过宽（本次登记，未改）**：无词界子串匹配 → `'ai'` 命中 `"mAIntenance"`、`'ml'`/`'dev'` 同理，非技术岗漏网（与注释「减噪音」的意图相反）。倾向：改词界匹配 `\b(...)\b` 并加回归样本；属**筛选行为变更**，需先评估召回损失（收紧可能误杀 `OpenAI`/`LLM` 类无词界写法）。
- **U1 补充（2026-09-14）**：本次已修掉其中一条**确定性**成因（脏日期 → 整源 rejected）。剩余成因（真实网络失败、源改版）仍不可区分，方案不变。
- **U3/U4 状态与本次测试的关系**：`loadState`/`saveState` 的失败路径**仍无测试**——它们碰 IO，需先抽成「以注入的读写函数为参数」的纯状态机方可离线断言（本次未做，产能优先级低于解析层）。
