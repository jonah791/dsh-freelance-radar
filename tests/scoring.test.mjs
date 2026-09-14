/**
 * scoring.ts 纯函数套件（离线、零网络、时间注入）。
 * 覆盖：正常路径 + 失败/退化路径（非法日期、空数组、边界阈值、排除词、幂等）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROFILE, daysSince, freshnessScore, scoreJob, rankJobs, jobFingerprint, sameJob,
} from '../lib/scoring.js'

const NOW = new Date('2026-09-14T00:00:00.000Z')

function job(over = {}) {
  return {
    id: 'j1', title: 'x', summary: '', url: 'u', source: 'eleduck',
    tags: [], publishedAt: '2026-09-14T00:00:00.000Z', ...over,
  }
}

// ---------- daysSince ----------

test('daysSince: 正常换算（整天/小数）', () => {
  assert.equal(daysSince('2026-09-14T00:00:00.000Z', NOW), 0)
  assert.equal(daysSince('2026-09-13T00:00:00.000Z', NOW), 1)
  assert.equal(daysSince('2026-09-12T12:00:00.000Z', NOW), 1.5)
})

test('daysSince: 退化路径——非法 ISO 返回 999（沉底而非抛错）、未来时间夹到 0', () => {
  assert.equal(daysSince('not-a-date', NOW), 999)
  assert.equal(daysSince('', NOW), 999)
  assert.equal(daysSince('2026-09-20T00:00:00.000Z', NOW), 0, '未来时间不得为负')
})

// ---------- freshnessScore ----------

test('freshnessScore: 阈值边界（≤3 满分 15 / ≥14 归零 / 中间线性衰减）', () => {
  assert.equal(freshnessScore(0), 15)
  assert.equal(freshnessScore(3), 15)
  assert.equal(freshnessScore(14), 0)
  assert.equal(freshnessScore(999), 0)
  assert.equal(freshnessScore(8.5), 8)   // 15*(1-5.5/11)=7.5 → round 8
  assert.equal(freshnessScore(4), 14)
})

test('freshnessScore: 单调不增（退化输入不得反向给分）', () => {
  let prev = Number.POSITIVE_INFINITY
  for (let d = 0; d <= 20; d += 0.5) {
    const v = freshnessScore(d)
    assert.ok(v <= prev, `days=${d} 时分数上升了（${prev} → ${v}）`)
    prev = v
  }
})

// ---------- scoreJob ----------

test('scoreJob: 正常路径——title 命中权重 2x、标签命中 6 分、远程 15 分、满分上限', () => {
  const s = scoreJob(job({ title: 'AI Agent 工程师', tags: ['远程', 'AI'] }), DEFAULT_PROFILE, NOW)
  assert.equal(s.excluded, false)
  assert.equal(s.breakdown.remote, 15)
  assert.equal(s.breakdown.tag, 12)          // 2 个命中标签 × 6
  assert.equal(s.breakdown.keyword, 16)      // title 恰命中 'ai' 与 'agent' 两条 × 8（非满额）
  assert.equal(s.breakdown.freshness, 15)
  assert.equal(s.score, s.breakdown.keyword + 12 + 15 + 15 + s.breakdown.quality)
  assert.ok(s.score <= 100)
})

test('scoreJob: 分项封顶——keyword 40 / tag 20（命中再多也不溢出）', () => {
  const s = scoreJob(job({
    title: 'ai llm agent gpt 大模型 智能体 人工智能 chatbot rag python',
    tags: ['AI', 'LLM', 'Agent', '远程', '全栈', 'Data', 'Devops', 'Backend', 'Frontend', 'Engineering'],
  }), { ...DEFAULT_PROFILE, excludeKeywords: [], mismatchSignals: [] }, NOW)
  assert.equal(s.breakdown.keyword, 40)
  assert.equal(s.breakdown.tag, 20)
  assert.equal(s.score, 40 + 20 + 15 + 15 + 3, 'quality=3（未关闭即得分；summary 空不计质量分）')
})

test('scoreJob: title > summary > tags 的命中权重差', () => {
  const t = scoreJob(job({ title: 'llm' }), DEFAULT_PROFILE, NOW).breakdown.keyword
  const m = scoreJob(job({ title: 'zz', summary: 'llm' }), DEFAULT_PROFILE, NOW).breakdown.keyword
  const g = scoreJob(job({ title: 'zz', tags: ['llm'] }), DEFAULT_PROFILE, NOW).breakdown.keyword
  assert.deepEqual([t, m, g], [8, 4, 3])
})

test('scoreJob: 排除词硬过滤（命中即 excluded 且 score=0、带原因）', () => {
  const s = scoreJob(job({ title: '区块链 web3 岗位' }), DEFAULT_PROFILE, NOW)
  assert.equal(s.excluded, true)
  assert.equal(s.score, 0)
  assert.match(s.excludeReason, /命中排除词/)
  assert.deepEqual(s.breakdown, { keyword: 0, tag: 0, remote: 0, freshness: 0, quality: 0 })
})

test('scoreJob: 退化路径——单字符关键词不匹配（防噪音）', () => {
  const p = { ...DEFAULT_PROFILE, includeKeywords: ['a'], minScore: 0, mismatchSignals: [] }
  assert.equal(scoreJob(job({ title: 'a' }), p, NOW).breakdown.keyword, 0)
})

test('scoreJob: 退化路径——空画像/空 tags/空 summary 不抛错且分数为下限', () => {
  const empty = { title: '', includeTags: [], includeKeywords: [], excludeKeywords: [], mismatchSignals: [], minScore: 0, pages: 1 }
  const s = scoreJob({ ...job({ title: '', summary: '' }), tags: [] }, empty, NOW)
  assert.equal(s.excluded, false)
  assert.equal(s.breakdown.keyword, 0)
  assert.equal(s.breakdown.tag, 0)
  assert.equal(s.breakdown.remote, 0)
})

test('scoreJob: 质量信号——closed 扣分、内容长度阈值、mismatch 标记不降分', () => {
  const base = scoreJob(job({ title: 'AI', summary: 'x'.repeat(51) }), DEFAULT_PROFILE, NOW)
  assert.equal(base.breakdown.quality, 6)     // 3(未关闭) + 3(摘要>50)
  const withContent = scoreJob(job({ title: 'AI', summary: 'x'.repeat(51), content: 'y'.repeat(201) }), DEFAULT_PROFILE, NOW)
  assert.equal(withContent.breakdown.quality, 10)
  const closed = scoreJob(job({ title: 'AI', summary: 'x'.repeat(51), closed: true }), DEFAULT_PROFILE, NOW)
  assert.equal(closed.breakdown.quality, 3)
  const mm = scoreJob(job({ title: 'AI 岗位，需要 n8n 和 php' }), DEFAULT_PROFILE, NOW)
  assert.ok(mm.mismatch.includes('n8n') && mm.mismatch.includes('php'))
  const plain = scoreJob(job({ title: 'AI 岗位' }), DEFAULT_PROFILE, NOW)
  assert.equal('mismatch' in plain, false, '无命中时不得带 mismatch 键')
})

test('scoreJob: 脏日期不抛错（freshness 沉底为 0）', () => {
  const s = scoreJob(job({ title: 'AI', publishedAt: 'garbage' }), DEFAULT_PROFILE, NOW)
  assert.equal(s.breakdown.freshness, 0)
})

test('scoreJob: 幂等——同输入重复打分结果一致（无隐藏状态）', () => {
  const j = job({ title: 'AI Agent', tags: ['远程'] })
  assert.deepEqual(scoreJob(j, DEFAULT_PROFILE, NOW), scoreJob(j, DEFAULT_PROFILE, NOW))
})

// ---------- rankJobs ----------

test('rankJobs: 过滤低于 minScore 与 excluded，并按分数降序', () => {
  const p = { ...DEFAULT_PROFILE, minScore: 20, mismatchSignals: [] }
  const out = rankJobs([
    job({ id: 'low', title: 'zzz' }),
    job({ id: 'high', title: 'AI Agent LLM 工程师', tags: ['远程', 'AI'] }),
    job({ id: 'ban', title: '博彩 招聘' }),
  ], p, NOW)
  assert.deepEqual(out.map((s) => s.job.id), ['high'])
  assert.ok(out[0].score >= p.minScore)
})

test('rankJobs: 退化路径——空数组 / minScore 高于任何分数（返回空，不抛）', () => {
  assert.deepEqual(rankJobs([], DEFAULT_PROFILE, NOW), [])
  assert.deepEqual(rankJobs([job({ title: 'zzz' })], { ...DEFAULT_PROFILE, minScore: 101 }, NOW), [])
})

// ---------- fingerprint / sameJob ----------

test('jobFingerprint: 归一化（大小写/空白折叠）+ 截断 80 字', () => {
  const a = job({ source: 'eleduck', title: 'AI   Agent' })
  const b = job({ source: 'eleduck', title: 'ai agent' })
  assert.equal(jobFingerprint(a), jobFingerprint(b))
  assert.equal(jobFingerprint(job({ title: 'x'.repeat(200) })).length, 'eleduck|'.length + 80)
})

test('sameJob: 同源同题判同、异源或异题判异（id 不同不影响指纹）', () => {
  assert.equal(sameJob(job({ id: 'a', title: 'AI' }), job({ id: 'b', title: 'ai' })), true)
  assert.equal(sameJob(job({ title: 'AI' }), job({ source: 'wwr', title: 'AI' })), false)
  assert.equal(sameJob(job({ title: 'AI' }), job({ title: 'ML' })), false)
})
