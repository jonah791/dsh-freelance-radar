<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 自由职业任务雷达：聚合公开远程任务源（电鸭 API + RemoteOK/Remotive/WeWorkRemotely RSS）→ 按能力画像（AI/Agent/LLM 关键词 + 排除词）打分筛选 → 工具面呈现 + 今日摘要；只读采集、主人决策闭环，不自动投标
  inject: 'tools'
  tools: radar_scan, radar_list, radar_mark, radar_digest（4 个）
  runtime: host-only
  envDeps: 外网可达（电鸭 API + 三个 RSS 源，可配 eleduckApiBase）；单源失败不拖垮整体
  boundary: 对远程平台只发 GET（只读采集）；全部写操作只在本地 jobs.json；不自动推送、不自动投标
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-freelance-radar

<p align="center">
  <a href="https://github.com/jonah791/dsh-freelance-radar"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-62%20passed-brightgreen" alt="tests">
</p>

**一句话**：把公开远程任务源（电鸭 + RemoteOK / Remotive / WeWorkRemotely）按**能力画像**自动筛一遍——关键词命中打分、排除词硬过滤、指纹去重、状态留痕，最后给你一张「值得看」的高分清单和今日摘要。

**为什么值得用**：远程求职最贵的成本是**信息噪音**——平台上一半帖子是区块链/刷单/外派劳务，逐条读一遍等于白干。本插件把「**AI / Agent / LLM 定制**」画像写成可配置的 include/exclude 规则，自动砍掉噪音、按新鲜度与质量信号排序，并记住你看过的每一条（`new → considered → applied / ignored`），**且绝不替你做决定**：不自动投标、不自动推送、无定时器——推送与否由我拿到清单后自己判断。

## 能力

| 工具 | 用途 |
|------|------|
| `radar_scan` | 采集全部源最新任务 → 指纹去重入库 → 按画像打分排序 → 返回 top **15** 高分清单（跳过 `ignored` 与已关闭任务） |
| `radar_list` | 查看已收集任务：按状态（`new`/`considered`/`applied`/`ignored`）/ 来源 / `minScore` 过滤；`limit` 夹在 `[1,100]`（缺省 20） |
| `radar_mark` | 主人决策留痕：`considered`（考虑中）/ `applied`（已投递）/ `ignored`（忽略，不再推送），可附 `note` |
| `radar_digest` | 今日摘要：今天新增且达 `minScore` 的高分任务（前 5）+ `considered` 超 **3 天**未 `applied` 的待跟进项（前 5） |

## 打分规则（`scoring.ts`）

| 维度 | 上限 | 规则 |
|------|------|------|
| keyword | 40 | 每个 `includeKeyword`：title 命中 +8 / summary 命中 +4 / tag 命中 +3（择优计入，不叠加） |
| tag | 20 | 命中任一 `includeTag` 标签 +6，合计封顶 20 |
| remote | 15 | 任一标签匹配 `/远程\|兼职\|remote\|part-?time/i` → 15 |
| freshness | 15 | `≤3 天` 满分；`≥14 天` 归零；其间线性衰减 |
| quality | 10 | 未关闭 +3、正文 > 200 字 +4、摘要 > 50 字 +3（封顶 10） |
| 硬过滤 | — | 命中任一 `excludeKeyword` → 标记 `excluded`、分数归 0 |
| 弱信号 | — | 命中 `mismatchSignals` → 只记录 `mismatch[]`，**不降分**（供人工判断） |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-freelance-radar": "link:<工作区>/self-plugins/dsh-freelance-radar"
```

**2) 挂组合**（web profile patch 行；默认画像即可用）：

```yaml
- insert:
    - id: agent-freelance-radar
      name: dsh-freelance-radar
      # config（可选）：
      # profile:
      #   includeTags: [AI, LLM, 大模型, Agent, 远程, 线上兼职, 全栈]
      #   includeKeywords: [ai, llm, agent, gpt, 大模型, 智能体, typescript, python, rag]
      #   excludeKeywords: [区块链, web3, 币圈, 博彩, 刷单, 灰产]
      #   minScore: 60
```

**3) 30 秒验证**：调 `radar_scan` → 应返回 `{ok:true, ...}` + 一份 top 15 清单（**需要外网可达**；单源挂掉不影响其他源，且会在轨迹里留一行 `source/error`）。若只是验证接线，可先调 `radar_list`（纯本地读 `jobs.json`，不触网）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | **被消费**：4 个工具开头均判 `enabled`，关闭时返回 `{ok:false, error:'freelance-radar disabled'}` |
| `dataDir` | 无 | 空则用 `<DSH_HOME>/freelance-radar` |
| `eleduckApiBase` | `https://svc.eleduck.com/api/v1` | 电鸭 API 根 |
| `profile` | 无 | `Partial<RadarProfile>`，**浅合并**进内置默认画像（`minScore=60`、`pages=5`） |
| `rssSources` | 无 | ⚠ **声明但未被消费**——RSS 源地址在代码里硬编码（语义文档 §4.1 如实记录） |

## 落盘与自证（出问题时先看这里）

| 产物 | 落点 | 形状 |
|------|------|------|
| 任务库（**状态 + 去重**） | `<DSH_HOME>/freelance-radar/jobs.json` | `{jobs:[...]}`；每条约含 `id/source/title/url/status/firstSeenAt/updatedAt/lastScore/note`；`JSON.stringify(state, null, 2)` 覆盖写 |
| 自证轨迹 | `<DSH_HOME>/freelance-radar-trace.jsonl` | 一行一阶段 `{atMs, phase, build, pid, ...}` |

**阶段枚举**（`RadarTracePhase`）：`boot`（挂载配置）→ `scan/start` → `source/end` / `source/error`（每源一行报告）→ `scan/end`（含 `raw/kept/dropped` 统计与丢弃原因计数）。

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/freelance-radar-trace.jsonl"
# ① 跑的是哪个构建   → build = "<version>@<trace 模块 mtime ms>" + pid
# ② 谁发起 / 扫什么  → phase=boot 记挂载配置（白名单字段，**不含 profile 全文**）；scan/start 记扫描开始
# ③ 断在哪一段      → phase 枚举 + source/error 行的 failure 分类（按源定位，不是一句笼统 error）
# ④ 结果质量        → scan/end 的 raw/kept/dropped + 丢弃原因计数（去重/坏条/过滤各多少）
# ⑤ 耗时与预算      → durationMs（scan/end 全程；单源 20s 超时预算）
```

轨迹默认开启，可用环境变量 `DSH_RADAR_TRACE=0` 关闭。**观测不反噬主流程**：轨迹 IO 失败吞错，`DSH_HOME` 不可写时扫描照常返回（有接线级尸体测试钉住）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. **进程级**：`tail -1 "$DSH_HOME/freelance-radar-trace.jsonl"` 里 `build` 的 mtime **等于** `self-plugins/dsh-freelance-radar/lib/trace.js` 的 mtime ⇒ 进程在跑当前构建；
2. **落盘产物**：`jobs.json` 在 `radar_scan` / `radar_mark` 后 mtime 前进，且 `radar_list` 能看到刚入库的任务；
3. **行为级**：工具列表里有 `radar_scan` / `radar_list` / `radar_mark` / `radar_digest` 四个工具。

> 注意：**重新构建 ≠ 生效**——`lib/*.js` mtime 新只证明「构建过」，**进程启动时间晚于产物 mtime** 才算「在跑它」。改完源码必须 `npm run build` 并让预检看到新产物。

**回退**：
- 源码级：`git -C self-plugins/dsh-freelance-radar revert <commit>` → `npm run build` → `preflight_check` → 哨兵重启；
- 组合级：patch 里给 `agent-freelance-radar` 行加 `disabled: true`（或整体配置 `enabled: false`）→ 哨兵重启；后者更轻，工具会 fail-soft 返回 `disabled` 而不停用插件；
- 运行期：`jobs.json` 是**纯本地状态**，删掉只是丢失「已看过」记忆（下次扫描全部重新入库），不影响任何外部状态。

## 测试

```bash
npm run build && npm test        # build = tsc；test = node --test "tests/*.test.mjs"
```

**62 例离线测试**，`tests/scoring.test.mjs` / `tests/sources.test.mjs` / `tests/trace.test.mjs`，跑 `lib/` 产物（与运行时同源）：

- `scoring.test.mjs` — 打分与排序：各维度上限与权重、`freshness` 衰减分段、排除词硬过滤、弱信号不降分、指纹去重（同源同标题前 80 字符归一化）、状态序排序
- `sources.test.mjs` — 源解析与降级：**单源失败不拖垮整体**（某源返回 `null` 元素 → 必有一行 `source/error`，旧实现会 `allSettled` 静默丢整源）、第二轮同数据 `added=0`（「今天没新任务」可解释）
- `trace.test.mjs` — 轨迹层：路径解析、`DSH_RADAR_TRACE` 开关、统计合并与钳位、构建自报、**尸体测试**（`DSH_HOME` 不可写时扫描照常返回）

**网络与外部依赖**：单测**全部离线**（HTTP 以桩替代），不需要电鸭 API、不需要任何 RSS 源在线。**注意环境口径**：
- 在 **Windows（仓库自带脚本口径）** 跑：`node --test "tests/*.test.mjs"` → **62/62 全绿**（2026-09-14 实测）；
- 在 **WSL 下**跑同一条命令 → 61/62，唯一失败项是 `selfBuild` 构建自报用例：它把 `new URL(...,import.meta.url).pathname` 的盘符形态（Windows `E:/…` vs WSL `mnt/e/…`）直接喂给 `readPackageVersion`，在 WSL 下读不到 `package.json` 而返回空串——**是环境路径形态差异，不是运行时回归**（README 如实标注，未改测试）。

## 设计要点

- **I1 只读采集**：对远程平台**只发 GET**；全部写操作只在本地 `jobs.json`（全仓唯一 `writeFileSync` 在 `saveState`，可 grep 验证）。
- **I2 指纹去重**：同一条任务 = `source + title(前 80 字符, 归一化)`；重复入库不会新增（`added` 不增），因此「今天没新任务」是可解释的结论而不是故障。
- **I3 损坏即重置**（如实标注）：`jobs.json` 解析失败 → `loadState` 返回空库，**丢弃坏文件、不备份**——这是一处待改进的容错（语义文档 §10 U3）。
- **I4 写失败不致命**（如实标注）：`saveState` 的写失败被 catch 且**不报错**（静默，语义文档 §10 U4）——与「不许静默」纪律相抵，已登记。
- **I5 工具数固定 4**：`radar_scan` / `radar_list` / `radar_mark` / `radar_digest`。
- **I6 决策归爱丽丝**：插件**无定时器、无自动推送、无自动投标**（`ctx.effect` 内是空清理函数）；摘要只负责「把值得看的摆到桌上」，推送与否、投不投由我自己判断。
- **合规红线**：不做爬虫式高频抓取——只读公开 API/RSS，单源 20s 超时、失败即跳过。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量（I1–I6）、契约（配置 / **打分契约逐字** / 状态裁决表 / 调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题（U3/U4） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 姊妹插件 `dsh-agent-telegram` | 主动通知通道——`radar_digest` 的清单由我决定是否经它推送给主人 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
