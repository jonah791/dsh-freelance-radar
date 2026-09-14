/**
 * dsh-freelance-radar — 自由职业任务雷达插件
 *
 * 主人 2026-09-03 指示：信息收集 + 自主规划 + 自行决定开工。
 * 设计文档：docs/freelance-radar-design.md
 *
 * 职责：聚合公开远程任务源（v1 = 电鸭 API + RSS）→ 按主人能力画像
 * （AI/Agent/LLM + 排除词）打分筛选 → 工具面呈现 + digest 摘要。
 * 主人决策闭环：radar_scan 出高分清单 → 主人 mark（considered/applied/ignored）→
 * 爱丽丝经 telegram_send 推送/辅助 proposal。
 *
 * 原则：
 *   1. 只读采集：抓公开数据，不写回平台（合规红线：不自动投标）
 *   2. 本地决策：打分/筛选/去重全本地，能力画像可配置
 *   3. 决策归爱丽丝：插件给信号，推送/跟进由主会话执行
 *
 * 数据源（2026-09-03 实测）：
 *   - 电鸭: https://svc.eleduck.com/api/v1/posts?category=5&page=N（HTTP 200 验证）
 *     posts[]: id/title/summary/content(HTML)/closed/published_at/tags[{id,name}]/category
 *     tags: id 17=远程工作, 18=线上兼职
 *   - RSS: Jobicy/RemoteOK 等（v1 备选，轻量 XML 解析）
 *
 * 存储：$DSH_HOME/freelance-radar/jobs.json（去重 + 状态）
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_PROFILE, jobFingerprint, rankJobs, scoreJob } from './scoring.ts'
import type { Job, RadarProfile, ScoredJob } from './scoring.ts'
import {
  parseEleduckPostsDetailed, parseRemoteOkDetailed, parseRemotiveDetailed, parseWwrRssDetailed,
} from './sources.ts'
import type { EleduckRawPost, RemoteOKJob, RemotiveJob } from './sources.ts'
import {
  addReason, classifyFailure, clip, emptyStats, finalizeStats, mergeStats,
  radarTrace, radarTraceBoot, traceEnabled, traceSourceReport,
} from './trace.ts'
import type { RadarStats, SourceReport } from './trace.ts'

export const name = 'freelance-radar'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  /** 数据目录，默认 $DSH_HOME/freelance-radar */
  dataDir?: string
  /** 电鸭 API 根 */
  eleduckApiBase?: string
  /** 能力画像覆盖 */
  profile?: Partial<RadarProfile>
  /** RSS 源列表（v1 保留空） */
  rssSources?: string[]
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().required(false),
  eleduckApiBase: z.string().default('https://svc.eleduck.com/api/v1'),
  profile: z.any().required(false),
  rssSources: z.array(z.string()).required(false),
})

// ---------- 路径 ----------

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function resolveDataDir(config: Config): string {
  return config.dataDir || join(dshHome(), 'freelance-radar')
}

// ---------- 存储 ----------

export type JobStatus = 'new' | 'considered' | 'applied' | 'ignored'

interface StoredJob {
  job: Job
  status: JobStatus
  firstSeenAt: string
  updatedAt: string
  note?: string
  lastScore?: number
}

interface RadarState {
  jobs: StoredJob[]
}

const EMPTY_STATE: RadarState = { jobs: [] }

function loadState(path: string): RadarState {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RadarState>
      return { jobs: Array.isArray(raw.jobs) ? raw.jobs : [] }
    }
  } catch {
    // 损坏重置
  }
  return { jobs: [] }
}

function saveState(path: string, state: RadarState): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // 写失败不致命
  }
}

// ---------- 网络 IO（结果可判别：HTTP/网络失败 ≠ 没数据） ----------

/**
 * 抓取结果（2026-09-14 S4 证据层）：原实现把 HTTP/网络失败吞成 `null`，
 * 于是「**源挂了**」与「**没新任务**」在工具输出上完全同形——这正是「今天没新任务」假象的一半来源。
 * 返回值判别的另一侧（本次不改行为）：失败时各 fetchXxx 仍返回 0 条，与旧实现一致；
 * 差别只在**轨迹里有了一行 `source/error`**。
 */
type FetchOutcome<T> = { ok: true; data: T } | { ok: false; failure: string; error: string }

async function fetchRaw(url: string, timeoutMs: number, take: 'json' | 'text'): Promise<FetchOutcome<unknown>> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (freelance-radar/0.1)' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, failure: classifyFailure(`HTTP ${res.status}`), error: `HTTP ${res.status}` }
    return { ok: true, data: take === 'json' ? await res.json() : await res.text() }
  } catch (e) {
    const text = String((e as { message?: unknown })?.message ?? e)
    return { ok: false, failure: classifyFailure(text), error: clip(text, 200) }
  }
}

async function fetchJson<T>(url: string, timeoutMs = 20000): Promise<FetchOutcome<T>> {
  return await fetchRaw(url, timeoutMs, 'json') as FetchOutcome<T>
}

/** 抓取纯文本（RSS/HTML 用） */
async function fetchText(url: string, timeoutMs = 20000): Promise<FetchOutcome<string>> {
  return await fetchRaw(url, timeoutMs, 'text') as FetchOutcome<string>
}

/** 单源采集结果（含**清洗统计**：源原始条数/清洗后条数/丢弃依据）。 */
interface SourceOutcome {
  source: string
  ok: boolean
  jobs: Job[]
  stats: RadarStats
  failure?: string
  error?: string
}

/** 采集电鸭（增量：只抓前 N 页最新） */
async function fetchEleduck(apiBase: string, pages: number): Promise<SourceOutcome> {
  const out: Job[] = []
  const seen = new Set<string>()
  let stats = emptyStats()
  for (let page = 1; page <= Math.min(pages, 20); page++) {
    const res = await fetchJson<{ posts?: EleduckRawPost[] }>(
      `${apiBase}/posts?category=5&page=${page}`,
    )
    // 原实现：fetchJson 失败返回 null → `data?.posts === undefined` → break（保留前面页的产出）
    if (!res.ok) {
      return { source: 'eleduck', ok: false, jobs: out, stats: finalizeStats(stats, out.length), failure: res.failure, error: res.error }
    }
    const posts = res.data?.posts
    if (posts === undefined) break
    const parsed = parseEleduckPostsDetailed(posts)
    stats = mergeStats(stats, parsed.stats)
    let crossPage = 0
    for (const job of parsed.jobs) {
      if (seen.has(job.id)) {
        crossPage++
        continue
      }
      seen.add(job.id)
      out.push(job)
    }
    if (crossPage > 0) stats = addReason(stats, 'duplicate', crossPage)
    // 电鸭建议 1-2s 间隔，但本机实测无需——保持轻量只抓 1 页轮询即可
    if (posts.length < 25) break
    if (page >= 2) break // v1 只抓前 2 页（最新 50 条足够）
  }
  return { source: 'eleduck', ok: true, jobs: out, stats: finalizeStats(stats, out.length) }
}

// ---------- 国外源采集（2026-09-04 主人「把国外平台摸一遍」授权接入） ----------

/** 采集 RemoteOK（JSON API，~100 条） */
async function fetchRemoteOK(): Promise<SourceOutcome> {
  const res = await fetchJson<RemoteOKJob[]>('https://remoteok.com/api')
  if (!res.ok) return { source: 'remoteok', ok: false, jobs: [], stats: emptyStats(), failure: res.failure, error: res.error }
  if (!Array.isArray(res.data)) return { source: 'remoteok', ok: true, jobs: [], stats: emptyStats() }
  // [0] 是 {last_updated,legal} metadata，跳过 + 技术岗过滤 + 去重全在 parseRemoteOkDetailed
  const parsed = parseRemoteOkDetailed(res.data)
  return { source: 'remoteok', ok: true, jobs: parsed.jobs, stats: finalizeStats(parsed.stats, parsed.jobs.length) }
}

/** 采集 Remotive（JSON API） */
async function fetchRemotive(): Promise<SourceOutcome> {
  const res = await fetchJson<{ jobs?: RemotiveJob[] }>('https://remotive.com/api/remote-jobs?limit=100')
  if (!res.ok) return { source: 'remotive', ok: false, jobs: [], stats: emptyStats(), failure: res.failure, error: res.error }
  const jobs = res.data?.jobs
  if (!Array.isArray(jobs)) return { source: 'remotive', ok: true, jobs: [], stats: emptyStats() }
  const parsed = parseRemotiveDetailed(jobs)
  return { source: 'remotive', ok: true, jobs: parsed.jobs, stats: finalizeStats(parsed.stats, parsed.jobs.length) }
}

/** 采集 WeWorkRemotely（RSS，轻量正则解析） */
async function fetchWeWorkRemotely(): Promise<SourceOutcome> {
  const res = await fetchText('https://weworkremotely.com/categories/remote-programming-jobs.rss')
  if (!res.ok) return { source: 'wwr', ok: false, jobs: [], stats: emptyStats(), failure: res.failure, error: res.error }
  const parsed = parseWwrRssDetailed(res.data)
  return { source: 'wwr', ok: true, jobs: parsed.jobs, stats: finalizeStats(parsed.stats, parsed.jobs.length) }
}

/** 源清单（boot 行自报 + 逐源报告的顺序真源）。 */
const SOURCE_NAMES = ['eleduck', 'remoteok', 'remotive', 'wwr'] as const

/**
 * 全源采集（电鸭 + 国外）——**逐源报告收口**。
 *
 * 不变式（观测契约）：`SOURCE_NAMES` 有几个源，`reports` 就有几条——
 * 任何源失败（含 Promise rejected）都**必有一行**（`ok:false` + 失败分类），
 * 不再像旧实现那样被 `if (r.status === 'fulfilled')` 静默丢弃。
 */
async function fetchAllSources(apiBase: string, pages: number): Promise<{ jobs: Job[]; reports: SourceReport[] }> {
  const specs: [string, () => Promise<SourceOutcome>][] = [
    ['eleduck', () => fetchEleduck(apiBase, pages)],
    ['remoteok', () => fetchRemoteOK()],
    ['remotive', () => fetchRemotive()],
    ['wwr', () => fetchWeWorkRemotely()],
  ]
  // 逐源兜底（含耗时）：把「源抛错」变成一条报告，而不是丢掉这个源
  const runOne = async (name: string, fn: () => Promise<SourceOutcome>): Promise<{ jobs: Job[]; report: SourceReport }> => {
    const startedAtMs = Date.now()
    try {
      const value = await fn()
      return {
        jobs: value.jobs,
        report: {
          source: name, ok: value.ok, raw: value.stats.raw, hits: value.jobs.length, stats: value.stats,
          ...(value.failure !== undefined ? { failure: value.failure } : {}),
          ...(value.error !== undefined ? { error: value.error } : {}),
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      }
    } catch (e) {
      const text = String((e as { message?: unknown })?.message ?? e)
      return {
        jobs: [],
        report: {
          source: name, ok: false, raw: 0, hits: 0, failure: classifyFailure(text), error: clip(text, 200),
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      }
    }
  }
  const settled = await Promise.allSettled(specs.map(([name, fn]) => runOne(name, fn)))
  const jobs: Job[] = []
  const reports: SourceReport[] = []
  for (const [i, name] of SOURCE_NAMES.entries()) {
    const r = settled[i]
    if (r === undefined) continue
    if (r.status === 'fulfilled') {
      reports.push(r.value.report)
      jobs.push(...r.value.jobs)
    } else {
      // 兜底（runOne 已吞错，这里仍保留一行为——「源必有一条报告」是不变式）
      const text = String((r.reason as { message?: unknown })?.message ?? r.reason)
      reports.push({ source: name, ok: false, raw: 0, hits: 0, failure: classifyFailure(text), error: clip(text, 200), durationMs: 0 })
    }
  }
  return { jobs, reports }
}

// ---------- apply ----------

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-freelance-radar')
  const dataDir = resolveDataDir(config)
  const statePath = join(dataDir, 'jobs.json')
  const profile: RadarProfile = { ...DEFAULT_PROFILE, ...(config.profile ?? {}) }
  const eleduckApi = config.eleduckApiBase || 'https://svc.eleduck.com/api/v1'

  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    // 稍后写入时再试
  }

  if (traceEnabled()) {
    radarTraceBoot({
      enabled: config.enabled,
      dataDir,
      eleduckApiBase: eleduckApi,
      sources: [...SOURCE_NAMES],
      pages: profile.pages,
      minScore: profile.minScore,
    })
  }

  /** 合并新任务入库（按指纹去重，新任务 status=new） */
  function ingest(jobs: Job[]): { added: number; seen: number } {
    const state = loadState(statePath)
    const byFp = new Map(state.jobs.map((s) => [jobFingerprint(s.job), s]))
    let added = 0
    for (const job of jobs) {
      const fp = jobFingerprint(job)
      if (byFp.has(fp)) {
        byFp.get(fp)!.updatedAt = new Date().toISOString()
        continue
      }
      const now = new Date().toISOString()
      byFp.set(fp, { job, status: 'new', firstSeenAt: now, updatedAt: now })
      added++
    }
    saveState(statePath, { jobs: [...byFp.values()] })
    return { added, seen: byFp.size }
  }

  /** 全量扫描：各源采集 + 入库 + 打分排序（并落一轮扫描轨迹：start → 逐源 → end） */
  async function scanAll(): Promise<{ jobs: ScoredJob[]; added: number; total: number }> {
    const startedAtMs = Date.now()
    if (traceEnabled()) radarTrace({ phase: 'scan/start', durationMs: 0 })
    const { jobs: allJobs, reports } = await fetchAllSources(eleduckApi, profile.pages)
    // 每源必有且仅有一行（source/end 或 source/error）——「今天没新任务」与「源挂了」由此分界
    if (traceEnabled()) for (const report of reports) traceSourceReport(report)
    const { added } = ingest(allJobs)
    const state = loadState(statePath)
    const live = state.jobs.filter((s) => s.status !== 'ignored' && s.job.closed !== true)
    const ranked = rankJobs(live.map((s) => s.job), profile)
    if (traceEnabled()) {
      radarTrace({
        phase: 'scan/end',
        durationMs: Math.max(0, Date.now() - startedAtMs),
        fetched: allJobs.length,
        added,
        dups: Math.max(0, allJobs.length - added),
        live: live.length,
        sourcesOk: reports.filter((r) => r.ok).length,
        sourcesFailed: reports.filter((r) => !r.ok).length,
      })
    }
    return { jobs: ranked, added, total: live.length }
  }

  // ---------- 工具 ----------

  ctx.tools.register(defineTool({
    name: 'radar_scan',
    description: '任务雷达·采集扫描：抓取远程任务源（电鸭 API）最新任务 → 入库去重 → 按主人能力画像（AI/Agent/LLM 关键词+排除词）打分排序 → 返回高分清单。采集后可用 radar_list 细看、radar_mark 标记；如需推送到 telegram 由爱丽丝调用 telegram_send。',
    parameters: {
      push: { type: 'boolean', description: 'true=扫描后把 top 高分任务摘要准备好（返回 render 含推送文案），实际发送仍由爱丽丝 telegram_send 执行' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          scanned: { type: 'number' },
          added: { type: 'number' },
          total: { type: 'number' },
          topJobs: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        const tops = v.topJobs ?? []
        const lines = tops.slice(0, 10).map((s: any, i: number) =>
          `  ${i + 1}. [${s.score}分] ${s.job.title}${s.mismatch?.length ? ' ⚠️栈:' + s.mismatch.join('/') : ''}\n     来源:${s.job.source} 标签:${(s.job.tags ?? []).slice(0, 4).join('/') || '-'}\n     ${s.job.url}`)
        const text = `【雷达扫描】抓取${v.scanned ?? 0}条，新增${v.added ?? 0}，库内${v.total ?? 0}\n` +
          (lines.length > 0 ? `高分推荐(${tops.length}):\n` + lines.join('\n') : '暂无高分新任务')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { push?: boolean }) {
      if (!config.enabled) return { ok: false, error: 'freelance-radar disabled' }
      const { jobs, added, total } = await scanAll()
      const topJobs = jobs.slice(0, 15).map((s) => ({
        score: s.score,
        breakdown: s.breakdown,
        mismatch: s.mismatch ?? [],
        job: JSON.parse(JSON.stringify(s.job)),
      }))
      return { ok: true, scanned: jobs.length + added, added, total, topJobs: JSON.parse(JSON.stringify(topJobs)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'radar_list',
    description: '任务雷达·查看已收集任务：按状态（new/considered/applied/ignored）/来源/最低分过滤。new=新看到未处理；considered=考虑中；applied=已投；ignored=忽略。',
    parameters: {
      status: { type: 'string', enum: ['new', 'considered', 'applied', 'ignored'], description: '状态过滤' },
      source: { type: 'string', description: '来源过滤（eleduck 等）' },
      minScore: { type: 'number', description: '最低分（对 new/considered 实时打分）' },
      limit: { type: 'number', description: '条数上限（缺省 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'number' },
          jobs: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        const jobs = v.jobs ?? []
        if (jobs.length === 0) return [{ type: 'text', text: '无匹配任务。先 radar_scan 采集，或调整过滤条件。' }]
        const lines = jobs.map((s: any, i: number) => {
          const st = s.status ?? 'new'
          const mark = st === 'considered' ? '🤔' : st === 'applied' ? '📮' : st === 'ignored' ? '🙈' : '🆕'
          return `${mark} [${st}] ${s.title}\n   分数:${s.lastScore ?? '?'} 标签:${(s.tags ?? []).slice(0, 4).join('/') || '-'}\n   ${s.url}`
        })
        return [{ type: 'text', text: `雷达任务(${v.total ?? 0} 条，显示 ${jobs.length}):\n` + lines.join('\n') }]
      },
    },
    async execute(args: { status?: string; source?: string; minScore?: number; limit?: number }) {
      if (!config.enabled) return { ok: false, error: 'freelance-radar disabled' }
      const state = loadState(statePath)
      let filtered = state.jobs
      if (args.status !== undefined) filtered = filtered.filter((s) => s.status === args.status)
      if (args.source !== undefined) filtered = filtered.filter((s) => s.job.source === args.source)
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
      // 实时打分（scoreJob：显示真实分数，不被 minScore 过滤；excluded 给 0 分）
      const scored = filtered.map((s) => {
        const sc = scoreJob(s.job, profile)
        return {
          title: s.job.title,
          url: s.job.url,
          source: s.job.source,
          tags: s.job.tags,
          status: s.status,
          firstSeenAt: s.firstSeenAt,
          note: s.note,
          excluded: sc.excluded,
          excludeReason: sc.excludeReason ?? null,
          lastScore: sc.excluded ? 0 : sc.score,
        }
      })
      if (args.minScore !== undefined) {
        const ms = args.minScore ?? 0
        const msJobs = scored.filter((s) => (s.lastScore ?? 0) >= ms)
        return {
          ok: true,
          total: msJobs.length,
          jobs: JSON.parse(JSON.stringify(msJobs.slice(0, limit))),
        }
      }
      // 排序：new/considered 优先 + 分数高优先
      const order: Record<string, number> = { new: 0, considered: 1, applied: 2, ignored: 3 }
      scored.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.lastScore ?? 0) - (a.lastScore ?? 0))
      return { ok: true, total: filtered.length, jobs: JSON.parse(JSON.stringify(scored.slice(0, limit))) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'radar_mark',
    description: '任务雷达·标记状态：considered=考虑中（准备投）/ applied=已投递 / ignored=忽略（不再推送）。主人决策留痕。',
    parameters: {
      jobId: { type: 'string', required: true, description: '任务 id（radar_list 返回的 title 对应的 job id，可用 radar_find 查；格式 eleduck-xxx）' },
      status: { type: 'string', required: true, enum: ['considered', 'applied', 'ignored'], description: '目标状态' },
      note: { type: 'string', description: '备注（如 已发 proposal / 不合适原因）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          jobId: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? `已标记 [${v.jobId}] → ${v.status}` : `标记失败：${String(v.error ?? '')}` }],
    },
    async execute(args: { jobId: string; status: string; note?: string }) {
      if (!config.enabled) return { ok: false, error: 'freelance-radar disabled' }
      const state = loadState(statePath)
      const found = state.jobs.find((s) => s.job.id === args.jobId)
      if (found === undefined) {
        return { ok: false, error: `job ${args.jobId} 不存在（先 radar_scan 采集）` }
      }
      found.status = args.status as JobStatus
      found.updatedAt = new Date().toISOString()
      if (args.note !== undefined) found.note = args.note
      saveState(statePath, state)
      return { ok: true, jobId: args.jobId, status: args.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'radar_digest',
    description: '任务雷达·今日摘要：高分新任务（今天新增且分数≥阈值）+ 待跟进项（considered 超 3 天未 applied 提醒跟进）。感知圈/每日巡检用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          date: { type: 'string' },
          highlights: { type: 'json' },
          pendingFollowups: { type: 'json' },
          summary: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        const today = String(v.date ?? '').slice(0, 10)
        const hl = v.highlights ?? []
        const pf = v.pendingFollowups ?? []
        const lines: string[] = []
        if (hl.length > 0) {
          lines.push('今日高分新任务:')
          for (const h of hl) lines.push(`  [${h.score}分] ${h.title}\n     ${h.url}`)
        }
        if (pf.length > 0) {
          lines.push('待跟进(considered 超3天):')
          for (const p of pf) lines.push(`  ⏰ ${p.title}（${p.consideredDays}天前标记，${p.note ?? '无备注'}）\n     ${p.url}`)
        }
        if (lines.length === 0) lines.push('今日无高分新任务、无待跟进——雷达平静。')
        return [{ type: 'text', text: `【雷达摘要 · ${today}】\n` + lines.join('\n') + `\n${v.summary ?? ''}` }]
      },
    },
    async execute() {
      if (!config.enabled) return { ok: false, error: 'freelance-radar disabled' }
      const state = loadState(statePath)
      const now = new Date()
      const todayKey = now.toISOString().slice(0, 10)
      // 高分新任务：今天 firstSeen + 实时打分 ≥ minScore
      const highlights = state.jobs
        .filter((s) => s.status === 'new' && s.firstSeenAt.slice(0, 10) === todayKey && s.job.closed !== true)
        .map((s) => ({ job: s.job, scored: rankJobs([s.job], profile)[0] ?? null }))
        .filter((x) => x.scored !== null && x.scored.score >= profile.minScore)
        .sort((a, b) => (b.scored!.score) - (a.scored!.score))
        .slice(0, 5)
        .map((x) => ({ title: x.job.title, url: x.job.url, score: x.scored!.score }))
      // 待跟进：considered 超 3 天
      const pendingFollowups = state.jobs
        .filter((s) => s.status === 'considered')
        .map((s) => {
          const days = Math.floor((now.getTime() - new Date(s.updatedAt).getTime()) / 86400000)
          return { title: s.job.title, url: s.job.url, note: s.note, consideredDays: days }
        })
        .filter((x) => x.consideredDays >= 3)
        .sort((a, b) => b.consideredDays - a.consideredDays)
        .slice(0, 5)
      const summary =
        `今日新增高分 ${highlights.length} 条` +
        (pendingFollowups.length > 0 ? ` · ${pendingFollowups.length} 条待跟进` : '') +
        ' · 雷达正常巡检'
      return {
        ok: true,
        date: now.toISOString(),
        highlights: JSON.parse(JSON.stringify(highlights)),
        pendingFollowups: JSON.parse(JSON.stringify(pendingFollowups)),
        summary,
      }
    },
  }))

  ctx.effect(() => () => {
    // 无长生命周期资源
  })

  logger.info(`ready (dataDir=${dataDir}, eleduck=${eleduckApi}, profile=${profile.title}, minScore=${profile.minScore})`)
}
