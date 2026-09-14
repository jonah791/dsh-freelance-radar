/**
 * dsh-freelance-radar 扫描轨迹（可维护性 S4 证据层 · 2026-09-14）。
 *
 * 动机（真事故形状）：本插件刚修过一个「**一条脏日期条目让整个源静默消失**」的缺陷——
 * `new Date(v).toISOString()` 对非法日期抛 `RangeError`，而三处调用都在 `Promise.allSettled` 里，
 * 于是 `if (r.status === 'fulfilled')` 把 rejected 的源**整源丢掉**：表现就是「今天没新任务」。
 * 日期归一已修，但**结构性静默仍在**：`Promise.allSettled` + 只取 fulfilled = 任何源抛错仍然无声消失；
 * 且 `fetchJson/fetchText` 把 HTTP 失败吞成 `null` ⇒「源挂了」与「没新任务」在输出上同形。
 *
 * 修法：每轮扫描与**每个源**都落一行可 `tail`/`grep` 的 JSONL 侧车——
 * `<DSH_HOME>/freelance-radar-trace.jsonl`（一行一阶段，`atMs` 单调）。
 * 阶段枚举：`boot` → `scan/start` → 每源一行 `source/end`|`source/error` → `scan/end`。
 * **不变式：源有几条，`source/*` 行就有几条**——任何源消失（含 rejected）都能一眼看出。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑的是哪个构建 → `build`（`<version>@<模块 mtime ms>`）+ `cfg`（boot 行）
 *   Q2 谁发起 / 抓哪个源   → `source`（`eleduck`/`remoteok`/`remotive`/`wwr`）+ `pid`
 *   Q3 断在哪一段         → `phase` 枚举 + `failure`（可 grep 分类）+ `error`
 *   Q4 结果质量           → `raw`（源原始条数）/ `hits`（清洗后）/ `stats.reasons`（**脏数据丢弃依据**）
 *                           + `scan/end` 的 `fetched/added/dups/live`（入库闭环）
 *   Q5 耗时与预算         → `durationMs`（每源 / 整轮）
 *
 * 隐私红线：只记**计数与源名**——任务标题/正文/URL **不落盘**（正文可能含联系方式等个人信息；
 * 落库路径 `jobs.json` 已由业务负责）。启动配置只记白名单字段（无 profile 全文）。
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`，扫描行为不受影响。
 *
 * @module dsh-freelance-radar/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 阶段枚举（`boot` 一行；每轮扫描 `scan/start` → 每源 `source/*` → `scan/end`）。 */
export type RadarTracePhase = 'boot' | 'scan/start' | 'source/end' | 'source/error' | 'scan/end'

/** boot 阶段自报的生效面（只记白名单字段）。 */
export interface RadarTraceConfig {
  enabled: boolean
  dataDir: string
  eleduckApiBase: string
  sources: string[]
  /** 每轮抓取页数（`profile.pages`）。 */
  pages: number
  /** 高分阈值（`profile.minScore`）。 */
  minScore: number
}

/**
 * 清洗统计（Q4 的「命中条数 / 脏数据丢弃数 / 依据」）——本插件解析层（`sources.ts`）与轨迹共用同一形状。
 * `reasons` 是可 grep 的丢弃依据（如 `bad-entry`/`duplicate`/`non-tech`/`bad-item`）。
 */
export interface RadarStats {
  /** 源给的原始条目数。 */
  raw: number
  /** 清洗/去重/过滤后保留数。 */
  kept: number
  /** 丢弃总数（= raw − kept）。 */
  dropped: number
  reasons?: Record<string, number>
}

/** 一个源的一次采集结果（`fetchAllSources` 的逐源报告，**每个源必有**）。 */
export interface SourceReport {
  source: string
  ok: boolean
  /** 失败分类（`ok=false` 时；可 grep）。 */
  failure?: string
  /** 失败原文（裁剪）。 */
  error?: string
  raw: number
  hits: number
  stats?: RadarStats
  durationMs: number
}

/** 一行雷达轨迹。 */
export interface RadarTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: RadarTracePhase
  /** 本插件构建标识 `<version>@<trace 模块 mtime ms>`。 */
  build: string
  /** 进程 pid。 */
  pid: number
  /** 源名（`eleduck`/`remoteok`/`remotive`/`wwr`）；`scan/*` 与 `boot` 行省略。 */
  source?: string
  /** 阶段耗时（`scan/start` = 0）。 */
  durationMs: number
  /** 源给的原始条目数 / 清洗后条数 / 丢弃总数 / 丢弃依据。 */
  raw?: number
  hits?: number
  dropped?: number
  reasons?: Record<string, number>
  /** `scan/end`：本轮各源合计抓取条数。 */
  fetched?: number
  /** `scan/end`：本轮新入库条数。 */
  added?: number
  /** `scan/end`：本轮因已存在而跳过的条数（`fetched − added`）。 */
  dups?: number
  /** `scan/end`：库内在库条数（非 ignored 且未 closed）。 */
  live?: number
  /** `scan/end`：成功源数 / 失败源数（「今天没新任务」与「源挂了」的分界）。 */
  sourcesOk?: number
  sourcesFailed?: number
  /** 失败分类（`source/error`）。 */
  failure?: string
  /** 失败原文（裁剪到 200 字符）。 */
  error?: string
  /** 仅 boot。 */
  cfg?: RadarTraceConfig
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定，单一真源）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数，便于测试与文档化）。 */
export function radarTracePath(home: string): string {
  return join(home, 'freelance-radar-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串——尽力而为，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识：`<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

let cachedSelfBuild: string | undefined

/** 本模块自身的构建标识（Q1：进程级自报；文件不可得退化为 `unknown@0`，进程内缓存）。 */
export function selfBuild(): string {
  if (cachedSelfBuild !== undefined) return cachedSelfBuild
  try {
    const file = fileURLToPath(import.meta.url)
    cachedSelfBuild = buildStamp(file, readPackageVersion(file))
  } catch {
    cachedSelfBuild = 'unknown@0'
  }
  return cachedSelfBuild
}

/** 统计合并（纯函数）：多页/多段清洗结果求和（`reasons` 逐键相加）。 */
export function mergeStats(a: RadarStats, b: RadarStats): RadarStats {
  const reasons: Record<string, number> = { ...(a.reasons ?? {}) }
  for (const [k, v] of Object.entries(b.reasons ?? {})) reasons[k] = (reasons[k] ?? 0) + v
  return {
    raw: a.raw + b.raw,
    kept: a.kept + b.kept,
    dropped: a.dropped + b.dropped,
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
  }
}

/** 空统计（脏源/未解析时的占位：raw=kept=dropped=0）。 */
export function emptyStats(): RadarStats {
  return { raw: 0, kept: 0, dropped: 0 }
}

/**
 * 归一化统计（纯函数）：`kept` 以**最终产出**为准——多页/跨页二次去重之后，
 * 只有 `raw − kept` 才是真实的丢弃总数（逐页统计会把跨页重复算漏）。
 */
export function finalizeStats(stats: RadarStats, kept: number): RadarStats {
  return {
    raw: stats.raw,
    kept,
    dropped: Math.max(0, stats.raw - kept),
    ...(stats.reasons !== undefined ? { reasons: stats.reasons } : {}),
  }
}

/** 追加一条丢弃原因计数（纯函数，返回新对象；`count <= 0` 原样返回）。 */
export function addReason(stats: RadarStats, why: string, count: number): RadarStats {
  if (count <= 0) return stats
  return { ...stats, reasons: { ...(stats.reasons ?? {}), [why]: (stats.reasons?.[why] ?? 0) + count } }
}

/** 失败分类（纯函数，Q3）：把自由文本错误归到一个**可 grep 的类别**。 */
export function classifyFailure(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('aborterror') || t.includes('aborted')) return 'abort'
  if (t.includes('timeout') || t.includes('timed out') || t.includes('etimedout')) return 'timeout'
  if (t.includes('enotfound') || t.includes('getaddrinfo') || t.includes('dns')) return 'dns'
  if (t.includes('econnrefused') || t.includes('econnreset') || t.includes('ehostunreach')) return 'refused'
  if (/\bhttp 5\d\d\b/.test(t)) return 'http-5xx'
  if (/\bhttp 4\d\d\b/.test(t)) return 'http-4xx'
  if (t.includes('fetch failed') || t.includes('socket') || t.includes('network')) return 'network'
  if (t.includes('json') || t.includes('parse') || t.includes('unexpected token')) return 'parse'
  return 'unknown'
}

/** 文本裁剪（落盘用；末尾标出被砍字符数）。 */
export function clip(text: string, maxLen = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}...(+${String(flat.length - maxLen)})`
}

/** 稳定序列化（键序固定 + 单行 JSON，便于 `tail`/`grep`）。 */
export function serializeTraceEntry(entry: RadarTraceEntry): string {
  const ordered: RadarTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    pid: entry.pid,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    durationMs: entry.durationMs,
    ...(entry.raw !== undefined ? { raw: entry.raw } : {}),
    ...(entry.hits !== undefined ? { hits: entry.hits } : {}),
    ...(entry.dropped !== undefined ? { dropped: entry.dropped } : {}),
    ...(entry.reasons !== undefined ? { reasons: entry.reasons } : {}),
    ...(entry.fetched !== undefined ? { fetched: entry.fetched } : {}),
    ...(entry.added !== undefined ? { added: entry.added } : {}),
    ...(entry.dups !== undefined ? { dups: entry.dups } : {}),
    ...(entry.live !== undefined ? { live: entry.live } : {}),
    ...(entry.sourcesOk !== undefined ? { sourcesOk: entry.sourcesOk } : {}),
    ...(entry.sourcesFailed !== undefined ? { sourcesFailed: entry.sourcesFailed } : {}),
    ...(entry.failure !== undefined ? { failure: entry.failure } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.cfg !== undefined ? { cfg: entry.cfg } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛（轨迹是证据，不是契约校验器）。 */
export function parseTraceEntries(text: string): RadarTraceEntry[] {
  const out: RadarTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as RadarTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): RadarTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：轨迹是观测，绝不因写不进去而影响扫描结果）。 */
export function appendTraceEntry(path: string, entry: RadarTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔雷达轨迹（薄接线：补 atMs/pid/build，路径缺省 `<DSH_HOME>/freelance-radar-trace.jsonl`）。 */
export function radarTrace(
  entry: Omit<RadarTraceEntry, 'atMs' | 'pid' | 'build'>,
  opts: { path?: string; home?: string; now?: number; pid?: number; build?: string } = {},
): boolean {
  const path = opts.path ?? radarTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, {
    atMs: opts.now ?? Date.now(),
    pid: opts.pid ?? process.pid,
    build: opts.build ?? selfBuild(),
    ...entry,
  })
}

/** 装载自报（`apply` 调用一次）：Q1 = 跑的是哪个构建 + 源清单/阈值/数据目录。 */
export function radarTraceBoot(
  cfg: RadarTraceConfig,
  opts: { path?: string; home?: string; now?: number; pid?: number; build?: string } = {},
): boolean {
  return radarTrace({ phase: 'boot', durationMs: 0, cfg }, opts)
}

/**
 * 逐源报告 → 轨迹行（**每源必有一行**：`ok` → `source/end`，否则 `source/error`）。
 * 把「一行一源」这条不变式收在一个函数里，避免调用点各写一遍漏掉失败分支。
 */
export function traceSourceReport(
  report: SourceReport,
  opts: { path?: string; home?: string; now?: number; pid?: number; build?: string } = {},
): boolean {
  return radarTrace({
    phase: report.ok ? 'source/end' : 'source/error',
    source: report.source,
    durationMs: report.durationMs,
    raw: report.raw,
    hits: report.hits,
    ...(report.stats !== undefined ? { dropped: report.stats.dropped } : {}),
    ...(report.stats?.reasons !== undefined ? { reasons: report.stats.reasons } : {}),
    ...(report.failure !== undefined ? { failure: report.failure } : {}),
    ...(report.error !== undefined ? { error: report.error } : {}),
  }, opts)
}

/** 是否启用轨迹（`DSH_RADAR_TRACE=0` 关闭；缺省开启——证据层是默认行为，不是可选项）。 */
export function traceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['DSH_RADAR_TRACE'] !== '0'
}
