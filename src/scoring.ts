/**
 * dsh-freelance-radar — 纯逻辑层（打分/过滤/类型，零 IO，可离线单测）
 *
 * 设计文档：docs/freelance-radar-design.md §3.2 / §3.3
 */

// ---------- 类型 ----------

export interface JobTag {
  id: number
  name: string
}

/** 归一化的任务（各源解析后统一结构） */
export interface Job {
  id: string            // 源内唯一 id（如电鸭 post id）
  title: string
  summary: string
  url: string
  source: string        // 'eleduck' | 'rss' | ...
  tags: string[]
  publishedAt: string   // ISO
  closed?: boolean
  content?: string      // 详细内容（可选，v1 不存全文）
}

/** 主人能力画像 */
export interface RadarProfile {
  title: string
  includeTags: string[]
  includeKeywords: string[]
  excludeKeywords: string[]
  /** 技术栈不匹配信号（v1.1 2026-09-04）：JD 含这些 = 标记 mismatch（提示非主人强项技术栈，
   *  不排除——有些可能可学/可外包）。主人强项 = TS/Node/Python/agent 框架自研/ComfyUI/WQ。 */
  mismatchSignals: string[]
  minScore: number
  /** 采集页数（每源） */
  pages: number
}

export const DEFAULT_PROFILE: RadarProfile = {
  title: 'AI Agent / LLM 应用定制工程师',
  includeTags: ['AI', '人工智能', 'LLM', '大模型', 'Agent', '远程', '线上兼职', '全栈', 'Software Development', 'Data', 'Devops', 'AI Engineer', 'Engineering', 'Full-Stack', 'Backend', 'Frontend'],
  includeKeywords: ['ai', 'llm', 'agent', 'gpt', '大模型', '智能体', '人工智能', '全栈', 'typescript', 'python', 'chatbot', 'rag', 'machine learning', 'deep learning', 'data engineer', 'ml', 'artificial intelligence', 'full stack', 'backend', 'frontend', 'software engineer', 'developer', 'devops', 'architecture', 'openai', 'langchain', 'comfyui', 'stable diffusion'],
  excludeKeywords: ['区块链', 'web3', '币圈', '虚拟币', '博彩', '刷单', '灰产', '加密货币', 'token 众筹', '刷量'],
  mismatchSignals: ['n8n', 'wordpress', 'php', 'java', 'c#', '.net', 'unity', 'flutter', 'react native', '小程序原生', 'django', 'ruby', 'golang', 'lua'],
  minScore: 60,
  pages: 5,
}

export interface ScoreBreakdown {
  keyword: number
  tag: number
  remote: number
  freshness: number
  quality: number
}

export interface ScoredJob {
  job: Job
  score: number
  breakdown: ScoreBreakdown
  excluded: boolean
  excludeReason?: string
  /** 技术栈不匹配信号（命中的 mismatchSignals，v1.1） */
  mismatch?: string[]
}

// ---------- 工具 ----------

/** 归一化小写 + 去空格（用于关键词匹配） */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ')
}

/** 中英文关键词匹配：haystack 是否含 needle（子串匹配，长度 ≥2 才生效防误伤） */
function contains(haystack: string, needle: string): boolean {
  const n = norm(needle).trim()
  if (n.length === 0) return false
  if (n.length === 1) return false // 单字符不匹配（噪音）
  return norm(haystack).includes(n)
}

/** 排除词命中（命中任一条即排除） */
function hasExclude(text: string, excludes: string[]): string | null {
  for (const kw of excludes) {
    if (contains(text, kw)) return kw
  }
  return null
}

/** 天数差（ISO → 距今） */
export function daysSince(iso: string, now: Date): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 999
  return Math.max(0, (now.getTime() - t) / 86400000)
}

/** 新鲜度分：3 天内满分 15，14 天衰减到 0 */
export function freshnessScore(days: number): number {
  if (days <= 3) return 15
  if (days >= 14) return 0
  return Math.round(15 * (1 - (days - 3) / 11))
}

// ---------- 打分主函数 ----------

/**
 * 对一条任务打分。
 * 返回 excluded=true 时 score 无意义（命中排除词）。
 */
export function scoreJob(job: Job, profile: RadarProfile, now = new Date()): ScoredJob {
  const haystack = job.title + ' ' + job.summary + ' ' + (job.content ?? '') + ' ' + job.tags.join(' ')

  // 排除词（硬过滤）
  const ex = hasExclude(haystack, profile.excludeKeywords)
  if (ex !== null) {
    return { job, score: 0, breakdown: { keyword: 0, tag: 0, remote: 0, freshness: 0, quality: 0 }, excluded: true, excludeReason: '命中排除词: ' + ex }
  }

  // ① 关键词命中（40 分）：title 命中 2x
  let keyword = 0
  for (const kw of profile.includeKeywords) {
    if (contains(job.title, kw)) keyword += 8   // title 命中权重高
    else if (contains(job.summary, kw)) keyword += 4
    else if (job.tags.some((t) => contains(t, kw))) keyword += 3
  }
  keyword = Math.min(40, keyword)

  // ② 标签命中（20 分）
  let tag = 0
  for (const t of job.tags) {
    for (const it of profile.includeTags) {
      if (contains(t, it)) {
        tag += 6
        break
      }
    }
  }
  tag = Math.min(20, tag)

  // ③ 远程友好（15 分）：远程/兼职标签
  const remote = job.tags.some((t) => /远程|兼职|remote|part-?time/i.test(t)) ? 15 : 0

  // ④ 新鲜度（15 分）
  const freshness = freshnessScore(daysSince(job.publishedAt, now))

  // ⑤ 质量信号（10 分）：详细内容/非 closed
  let quality = 0
  if (job.closed !== true) quality += 3
  if ((job.content?.length ?? 0) > 200) quality += 4
  if (job.summary.length > 50) quality += 3
  quality = Math.min(10, quality)

  const score = keyword + tag + remote + freshness + quality

  // ⑥ 技术栈不匹配信号（v1.1）：命中 mismatchSignals 的标记出来（提示主人非强项栈，
  // 不排除不降分——可能可学/可外包；主要防「高分推荐但技术栈不符」的无效推送）
  const mismatch: string[] = []
  for (const sig of profile.mismatchSignals) {
    if (contains(haystack, sig)) mismatch.push(sig)
  }

  return {
    job,
    score,
    breakdown: { keyword, tag, remote, freshness, quality },
    excluded: false,
    ...(mismatch.length > 0 ? { mismatch } : {}),
  }
}

/** 过滤 + 排序：非 excluded 且 ≥ minScore，按分数降序 */
export function rankJobs(jobs: Job[], profile: RadarProfile, now = new Date()): ScoredJob[] {
  return jobs
    .map((j) => scoreJob(j, profile, now))
    .filter((s) => !s.excluded && s.score >= profile.minScore)
    .sort((a, b) => b.score - a.score)
}

/** 任务指纹（去重用）：source + title 归一化 */
export function jobFingerprint(job: Job): string {
  return job.source + '|' + norm(job.title).slice(0, 80)
}

/** 判断两条任务是否同指纹 */
export function sameJob(a: Job, b: Job): boolean {
  return jobFingerprint(a) === jobFingerprint(b)
}
