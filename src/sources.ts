/**
 * dsh-freelance-radar — 数据源解析层（纯函数，零 IO）
 *
 * 2026-09-14 可维护性补课：这些解析器原先被困在 index.ts（与 fetch/apply 混在一起），
 * 无法离线验证「源返回脏数据会怎样」。本次**仅搬家**（行为逐字不变）：
 *   - stripHtml / eleduckToJob / remoteOkToJob / remotiveToJob（原 index.ts 同实现）
 *   - remoteok / remotive / wwr 的**列表级**清洗循环抽出为 parseXxx（原 fetchXxx 内的循环体）
 *   - fetchXxx（网络 IO）留在 index.ts，只负责取数据后调 parseXxx
 *
 * 不变量（tests/sources.test.mjs 锁住）：
 *   1. 解析器对脏数据一律返回 null / 跳过，**绝不抛错**（源字段缺失是常态，不是异常）
 *   2. 列表级解析必须彻底去重（同 id 只留首现），且 RemoteOK 必须跳过 [0] 的 metadata 元素
 *   3. 标题/摘要必须 stripHtml 后 trim 且截断（summary ≤300、content ≤800）
 *
 * 2026-09-14 S4 证据层：四个列表级解析器各有一个 `*Detailed` 变体，额外返回 `stats`
 * （`raw/kept/dropped/reasons` = 源原始条数 / 清洗后条数 / 脏数据丢弃数 / **丢弃依据**），供轨迹落盘；
 * 原名函数是它们的薄委托（行为逐字一致）。`RadarStats` 是**类型导入**，不引入任何 IO。
 */

import type { Job } from './scoring.ts'
import type { RadarStats } from './trace.ts'

// ---------- HTML ----------

/**
 * 安全 ISO 归一（2026-09-14 修复）：非法日期原实现走 `new Date(v).toISOString()`
 * → 抛 `RangeError: Invalid time value`。在 fetchRemoteOK/fetchRemotive/fetchWeWorkRemotely
 * 里这会被 Promise.allSettled 记为 rejected → **一条脏日期条目拖垮整个源**（静默丢数据）。
 * 现语义与「日期缺失」一致：回落到**注入的 now**（daysSince 判为最新，不抛错）。
 *
 * `now` 可注入（2026-09-14 二次修正）：此前兜底直接读 `Date.now()` ⇒ 纯函数不纯，
 * 单测里「同一输入调两次」会因毫秒差产生不同结果（实测 `…53.431Z` vs `…53.430Z` 假红）。
 * 默认值保持 `Date.now()` ⇒ 生产行为逐字不变。
 */
export function toIso(v: string | undefined, now: number = Date.now()): string {
  if (typeof v !== 'string' || v.length === 0) return new Date(now).toISOString()
  const t = new Date(v)
  return Number.isNaN(t.getTime()) ? new Date(now).toISOString() : t.toISOString()
}

/** HTML 摘要 → 纯文本（粗略去标签） */
export function stripHtml(s: string | undefined): string {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- 电鸭（eleduck） ----------

export interface EleduckRawPost {
  id?: string
  title?: string
  full_title?: string
  summary?: string
  content?: string
  closed?: boolean
  published_at?: string
  tags?: Array<{ id?: number; name?: string }>
  category?: { id?: number; name?: string }
}

/** 电鸭帖子 → Job（非法/空标题 → null，绝不抛） */
export function eleduckToJob(p: EleduckRawPost): Job | null {
  if (typeof p.id !== 'string' || typeof p.title !== 'string') return null
  const title = (p.full_title || p.title).trim()
  if (title.length === 0) return null
  const tags = (p.tags ?? []).map((t) => t.name ?? '').filter((s) => s.length > 0)
  return {
    id: 'eleduck-' + p.id,
    title,
    summary: stripHtml(p.summary).slice(0, 500) || stripHtml(p.content).slice(0, 300),
    url: 'https://eleduck.com/posts/' + p.id,
    source: 'eleduck',
    tags,
    publishedAt: p.published_at ?? new Date().toISOString(),
    closed: p.closed === true,
    content: stripHtml(p.content).slice(0, 2000),
  }
}

/** 电鸭 posts 列表 → Job[]（逐条转换 + 同 id 去重；坏条目跳过） */
export function parseEleduckPosts(posts: EleduckRawPost[]): Job[] {
  return parseEleduckPostsDetailed(posts).jobs
}

/**
 * 同上，但把**清洗依据**一并带出（2026-09-14 S4 证据层）：
 * `reasons` 键为 `bad-entry`（缺 id/title 或标题空）｜`duplicate`（同 id 重复）。
 * `parseEleduckPosts` 是本函数的薄委托（行为逐字一致，仅返回值取 `.jobs`）。
 */
export function parseEleduckPostsDetailed(posts: EleduckRawPost[]): { jobs: Job[]; stats: RadarStats } {
  const out: Job[] = []
  const seen = new Set<string>()
  const reasons: Record<string, number> = {}
  const drop = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1 }
  const raw = Array.isArray(posts) ? posts.length : 0
  for (const p of posts) {
    const job = eleduckToJob(p)
    if (job === null) {
      drop('bad-entry')
      continue
    }
    if (seen.has(job.id)) {
      drop('duplicate')
      continue
    }
    seen.add(job.id)
    out.push(job)
  }
  return {
    jobs: out,
    stats: { raw, kept: out.length, dropped: raw - out.length, ...(Object.keys(reasons).length > 0 ? { reasons } : {}) },
  }
}

// ---------- RemoteOK ----------

export interface RemoteOKJob {
  slug?: string
  id?: string
  position?: string
  company?: string
  tags?: string[]
  date?: string
  url?: string
  description?: string
  salary_min?: number
  salary_max?: number
}

/** RemoteOK → Job（[0] 是 metadata 需跳过，外面处理） */
export function remoteOkToJob(j: RemoteOKJob): Job | null {
  if (typeof j.slug !== 'string' || typeof j.position !== 'string') return null
  const title = j.position.trim()
  if (title.length === 0) return null
  const desc = stripHtml(j.description).slice(0, 800)
  return {
    id: 'remoteok-' + (j.slug || j.id),
    title: title + (j.company ? ' @ ' + j.company : ''),
    summary: desc.slice(0, 300),
    url: j.url || 'https://remoteok.com/remote-jobs/' + j.slug,
    source: 'remoteok',
    tags: (j.tags ?? []).filter((t) => typeof t === 'string'),
    publishedAt: toIso(j.date),
    content: desc,
  }
}

/** RemoteOK 免费源噪音大（酒店维修/邮差/地勤等非技术岗混入）——只收技术岗（2026-09-04） */
export const TECH_RE = /(engineer|developer|dev|software|programmer|architect|data|analyst|scientist|ai|ml|machine|full.?stack|backend|frontend|devops|sysadmin|sys.?admin|infosec|security|designer|product manager|technical|qa|test|support engineer|coder|programmer)/i

/** RemoteOK 原始数组 → Job[]（跳过 [0] metadata + 技术岗过滤 + 去重） */
export function parseRemoteOk(data: RemoteOKJob[]): Job[] {
  return parseRemoteOkDetailed(data).jobs
}

/**
 * 同上，但把**清洗依据**一并带出（2026-09-14 S4 证据层）：
 * `reasons` 键为 `metadata`（跳过 [0] 的 `{last_updated,legal}`）｜`bad-entry`｜`non-tech`（技术岗词表未命中）｜
 * `duplicate`。`raw` 含 metadata 元素（源给的原始数组长度）。
 */
export function parseRemoteOkDetailed(data: RemoteOKJob[]): { jobs: Job[]; stats: RadarStats } {
  const out: Job[] = []
  const seen = new Set<string>()
  const reasons: Record<string, number> = {}
  const drop = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1 }
  const raw = Array.isArray(data) ? data.length : 0
  if (raw > 0) drop('metadata')
  for (const j of data.slice(1)) {
    const job = remoteOkToJob(j)
    if (job === null) {
      drop('bad-entry')
      continue
    }
    if (seen.has(job.id)) {
      drop('duplicate')
      continue
    }
    const hay = job.title + ' ' + job.tags.join(' ')
    if (!TECH_RE.test(hay)) {
      drop('non-tech')
      continue
    }
    seen.add(job.id)
    out.push(job)
  }
  return {
    jobs: out,
    stats: { raw, kept: out.length, dropped: raw - out.length, ...(Object.keys(reasons).length > 0 ? { reasons } : {}) },
  }
}

// ---------- Remotive ----------

export interface RemotiveJob {
  id?: number
  url?: string
  title?: string
  company_name?: string
  category?: string
  tags?: string[]
  job_type?: string
  publication_date?: string
  salary?: string
  description?: string
  candidate_required_location?: string
}

/** Remotive → Job */
export function remotiveToJob(j: RemotiveJob): Job | null {
  if (typeof j.title !== 'string' || typeof j.url !== 'string') return null
  const title = j.title.trim()
  if (title.length === 0) return null
  const tags = [j.category, ...(j.tags ?? []), j.job_type, j.candidate_required_location]
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
  const desc = stripHtml(j.description).slice(0, 800)
  return {
    id: 'remotive-' + String(j.id ?? title),
    title: title + (j.company_name ? ' @ ' + j.company_name : ''),
    summary: desc.slice(0, 300),
    url: j.url,
    source: 'remotive',
    tags,
    publishedAt: toIso(j.publication_date),
    content: desc,
  }
}

/** Remotive jobs 列表 → Job[]（去重；坏条目跳过） */
export function parseRemotive(jobs: RemotiveJob[]): Job[] {
  return parseRemotiveDetailed(jobs).jobs
}

/** 同上 + 清洗依据（`bad-entry` 缺 title/url 或标题空 ｜ `duplicate`）——2026-09-14 S4 证据层。 */
export function parseRemotiveDetailed(jobs: RemotiveJob[]): { jobs: Job[]; stats: RadarStats } {
  const out: Job[] = []
  const seen = new Set<string>()
  const reasons: Record<string, number> = {}
  const drop = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1 }
  const raw = Array.isArray(jobs) ? jobs.length : 0
  for (const j of jobs) {
    const job = remotiveToJob(j)
    if (job === null) {
      drop('bad-entry')
      continue
    }
    if (seen.has(job.id)) {
      drop('duplicate')
      continue
    }
    seen.add(job.id)
    out.push(job)
  }
  return {
    jobs: out,
    stats: { raw, kept: out.length, dropped: raw - out.length, ...(Object.keys(reasons).length > 0 ? { reasons } : {}) },
  }
}

// ---------- WeWorkRemotely（RSS） ----------

/** RSS 文本 → Job[]（轻量正则解析；缺 title/link 的 item 跳过；重复 title 去重） */
export function parseWwrRss(xml: string): Job[] {
  return parseWwrRssDetailed(xml).jobs
}

/**
 * 同上 + 清洗依据（2026-09-14 S4 证据层）：`raw` = `<item>` 出现次数，
 * `reasons` 键为 `bad-item`（缺 title/link 标签）｜`empty`（title 或 link 去空白后为空）｜`duplicate`。
 */
export function parseWwrRssDetailed(xml: string): { jobs: Job[]; stats: RadarStats } {
  const out: Job[] = []
  const seen = new Set<string>()
  const reasons: Record<string, number> = {}
  const drop = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1 }
  let raw = 0
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    raw++
    const item = m[1]!
    const titleM = /<title>(.*?)<\/title>/.exec(item)
    const linkM = /<link>(.*?)<\/link>/.exec(item)
    const descM = /<description>(.*?)<\/description>/.exec(item)
    if (!titleM || !linkM) {
      drop('bad-item')
      continue
    }
    const title = stripHtml(titleM[1]!)
    const url = (linkM[1] ?? '').trim()
    if (title.length === 0 || url.length === 0) {
      drop('empty')
      continue
    }
    const pubM = /<pubDate>(.*?)<\/pubDate>/.exec(item)
    const desc = stripHtml(descM?.[1]).slice(0, 800)
    const job: Job = {
      id: 'wwr-' + title.slice(0, 60),
      title,
      summary: desc.slice(0, 300),
      url,
      source: 'wwr',
      tags: ['远程'],
      publishedAt: toIso(pubM?.[1]),
      content: desc,
    }
    if (seen.has(job.id)) {
      drop('duplicate')
      continue
    }
    seen.add(job.id)
    out.push(job)
  }
  return {
    jobs: out,
    stats: { raw, kept: out.length, dropped: raw - out.length, ...(Object.keys(reasons).length > 0 ? { reasons } : {}) },
  }
}
