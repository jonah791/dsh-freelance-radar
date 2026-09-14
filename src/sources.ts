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
 */

import type { Job } from './scoring.ts'

// ---------- HTML ----------

/**
 * 安全 ISO 归一（2026-09-14 修复）：非法日期原实现走 `new Date(v).toISOString()`
 * → 抛 `RangeError: Invalid time value`。在 fetchRemoteOK/fetchRemotive/fetchWeWorkRemotely
 * 里这会被 Promise.allSettled 记为 rejected → **一条脏日期条目拖垮整个源**（静默丢数据）。
 * 现语义与「日期缺失」一致：回落到当前时间（daysSince 判为最新，不抛错）。
 */
function toIso(v: string | undefined): string {
  if (typeof v !== 'string' || v.length === 0) return new Date().toISOString()
  const t = new Date(v)
  return Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString()
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
  const out: Job[] = []
  const seen = new Set<string>()
  for (const p of posts) {
    const job = eleduckToJob(p)
    if (job === null) continue
    if (seen.has(job.id)) continue
    seen.add(job.id)
    out.push(job)
  }
  return out
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
  const out: Job[] = []
  const seen = new Set<string>()
  for (const j of data.slice(1)) {
    const job = remoteOkToJob(j)
    if (job === null || seen.has(job.id)) continue
    const hay = job.title + ' ' + job.tags.join(' ')
    if (!TECH_RE.test(hay)) continue // 非技术岗跳过（减噪音）
    seen.add(job.id)
    out.push(job)
  }
  return out
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
  const out: Job[] = []
  const seen = new Set<string>()
  for (const j of jobs) {
    const job = remotiveToJob(j)
    if (job === null || seen.has(job.id)) continue
    seen.add(job.id)
    out.push(job)
  }
  return out
}

// ---------- WeWorkRemotely（RSS） ----------

/** RSS 文本 → Job[]（轻量正则解析；缺 title/link 的 item 跳过；重复 title 去重） */
export function parseWwrRss(xml: string): Job[] {
  const out: Job[] = []
  const seen = new Set<string>()
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1]!
    const titleM = /<title>(.*?)<\/title>/.exec(item)
    const linkM = /<link>(.*?)<\/link>/.exec(item)
    const descM = /<description>(.*?)<\/description>/.exec(item)
    if (!titleM || !linkM) continue
    const title = stripHtml(titleM[1]!)
    const url = (linkM[1] ?? '').trim()
    if (title.length === 0 || url.length === 0) continue
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
    if (seen.has(job.id)) continue
    seen.add(job.id)
    out.push(job)
  }
  return out
}
