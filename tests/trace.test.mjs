/**
 * dsh-freelance-radar 扫描轨迹 + 清洗统计单测（跑 lib 产物，零真实网络）。
 *
 * 覆盖：正常路径（路径解析/统计合并/序列化/落盘/回读）+ 退化路径（坏行/半行/缺失文件/脏统计）
 * + **尸体测试**（父路径是普通文件 → 返回 false 且不抛）+ 隐私/不变式（每源必有一行）
 * + 清洗依据统计（原缺陷面：脏条目让整源静默消失）+ **接线测试**（真 `apply` + 假 ctx + fetch 桩）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addReason,
  buildStamp,
  classifyFailure,
  clip,
  emptyStats,
  finalizeStats,
  lastScanAt,
  lastScanAtMs,
  mergeStats,
  parseTraceEntries,
  radarTrace,
  radarTraceBoot,
  radarTracePath,
  readPackageVersion,
  readTraceEntries,
  resolveHome,
  selfBuild,
  serializeTraceEntry,
  traceEnabled,
  traceSourceReport,
} from '../lib/trace.js'
import {
  parseEleduckPosts, parseEleduckPostsDetailed,
  parseRemoteOk, parseRemoteOkDetailed,
  parseRemotive, parseRemotiveDetailed,
  parseWwrRss, parseWwrRssDetailed,
  toIso,
} from '../lib/sources.js'
import { apply } from '../lib/index.js'

const tmp = mkdtempSync(join(tmpdir(), 'radar-trace-test-'))
process.env['DSH_HOME'] = join(tmp, 'home')

const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'source/end',
  build: '0.1.0@12345',
  pid: 4242,
  source: 'eleduck',
  durationMs: 812,
  ...entry,
})

// ---------- 路径与构建自报（Q1） ----------

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('radarTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(radarTracePath('/h/.dsh'), join('/h/.dsh', 'freelance-radar-trace.jsonl'))
})

test('selfBuild：<version>@<mtime ms> 形态且 mtime 来自产物；缓存稳定', () => {
  const build = selfBuild()
  assert.match(build, /^[^@]+@\d+$/)
  const [version, mtime] = build.split('@')
  const libTrace = fileURLToPath(new URL('../lib/trace.js', import.meta.url))
  assert.equal(version, readPackageVersion(libTrace))
  assert.ok(Number(mtime) > 0)
  assert.equal(selfBuild(), build)
  assert.equal(buildStamp('/nope/x.js', ''), 'unknown@0')
})

test('traceEnabled：DSH_RADAR_TRACE=0 关闭，其余（含缺失）开启', () => {
  assert.equal(traceEnabled({ DSH_RADAR_TRACE: '0' }), false)
  assert.equal(traceEnabled({}), true)
})

// ---------- 统计纯函数（Q4） ----------

test('mergeStats/finalizeStats/addReason/emptyStats：计数语义与钳位', () => {
  assert.deepEqual(emptyStats(), { raw: 0, kept: 0, dropped: 0 })
  const a = { raw: 10, kept: 6, dropped: 4, reasons: { 'bad-entry': 3, duplicate: 1 } }
  const b = { raw: 5, kept: 5, dropped: 0 }
  const merged = mergeStats(a, b)
  assert.deepEqual(merged, { raw: 15, kept: 11, dropped: 4, reasons: { 'bad-entry': 3, duplicate: 1 } })
  assert.equal(mergeStats(a, a).reasons['bad-entry'], 6)          // 逐键相加
  assert.deepEqual(addReason(a, 'duplicate', 2).reasons, { 'bad-entry': 3, duplicate: 3 })
  assert.equal(addReason(a, 'x', 0), a)                            // 0 计数原样返回
  assert.deepEqual(addReason({ raw: 1, kept: 1, dropped: 0 }, 'new', 1).reasons, { new: 1 })
  // 跨页二次去重后：kept 以最终产出为准，dropped 由 raw−kept 重算
  assert.deepEqual(finalizeStats({ raw: 10, kept: 6, dropped: 4, reasons: { duplicate: 4 } }, 3), {
    raw: 10, kept: 3, dropped: 7, reasons: { duplicate: 4 },
  })
  assert.equal(finalizeStats({ raw: 1, kept: 1, dropped: 0 }, 5).dropped, 0)  // 不可能的高 kept → 钳 0
})

test('classifyFailure：失败分类可 grep（超时/DNS/拒绝/HTTP/解析/未知）', () => {
  assert.equal(classifyFailure('TimeoutError: signal timed out'), 'timeout')
  assert.equal(classifyFailure('fetch failed: getaddrinfo ENOTFOUND x'), 'dns')
  assert.equal(classifyFailure('connect ECONNREFUSED 1.2.3.4:443'), 'refused')
  assert.equal(classifyFailure('HTTP 503'), 'http-5xx')
  assert.equal(classifyFailure('HTTP 404'), 'http-4xx')
  assert.equal(classifyFailure('The operation was aborted'), 'abort')
  assert.equal(classifyFailure('Unexpected token < in JSON'), 'parse')
  assert.equal(classifyFailure('???'), 'unknown')
})

test('clip：折平空白 + 超长带裁剪标记', () => {
  assert.equal(clip('a\n b', 200), 'a b')
  assert.equal(clip('y'.repeat(210), 200), `${'y'.repeat(200)}...(+10)`)
})

// ---------- 序列化 / 解析 / 落盘 ----------

test('serializeTraceEntry：单行 + 键序固定 + 缺省字段不污染', () => {
  const line = serializeTraceEntry(base({ hits: 3, raw: 5, dropped: 2 }))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'pid', 'source', 'durationMs', 'raw', 'hits', 'dropped',
  ])
  const full = JSON.parse(serializeTraceEntry(base({
    phase: 'scan/end', source: undefined, raw: undefined, hits: undefined, dropped: undefined,
    fetched: 40, added: 7, dups: 33, live: 120, sourcesOk: 3, sourcesFailed: 1,
    failure: 'http-5xx', error: 'HTTP 503',
  })))
  assert.deepEqual(Object.keys(full).slice(5), [
    'fetched', 'added', 'dups', 'live', 'sourcesOk', 'sourcesFailed', 'failure', 'error',
  ])  // scan/* 行无 source → durationMs 落在第 5 位（index 4）
})

test('parseTraceEntries：坏行/半行/空行/null 全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = ['', good, ' ', '{"atMs":1,"phase":"source/end"', '{"atMs":null,"phase":"x"}', 'null', '[]', 'zz'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].source, 'eleduck')
})

test('readTraceEntries：缺失文件 / 目录当文件读 → 空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'freelance-radar-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('radarTrace + 回读：追加不覆盖；注入 now/pid/build', () => {
  const path = join(tmp, 'ok', 'freelance-radar-trace.jsonl')
  radarTrace({ phase: 'scan/start', durationMs: 0 }, { path, now: 1, pid: 2, build: 'b@1' })
  radarTrace({ phase: 'scan/end', durationMs: 9, fetched: 3 }, { path, now: 2, pid: 2, build: 'b@1' })
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.phase), ['scan/start', 'scan/end'])
  assert.equal(back[0].build, 'b@1')
  assert.equal(back[1].fetched, 3)
  assert.equal(back[0].atMs, 1)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬扫描）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(radarTrace({ phase: 'scan/end', durationMs: 1 }, { path: join(blocker, 'x.jsonl') }), false)
  })
})

test('radarTraceBoot：boot 行自报生效面（不含 profile 全文）', () => {
  const path = join(tmp, 'boot', 'freelance-radar-trace.jsonl')
  const cfg = {
    enabled: true, dataDir: '/d/radar', eleduckApiBase: 'https://svc.eleduck.com/api/v1',
    sources: ['eleduck', 'remoteok'], pages: 2, minScore: 45,
  }
  assert.equal(radarTraceBoot(cfg, { path, now: 5, pid: 6, build: 'b@2' }), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.phase, 'boot')
  assert.deepEqual(line.cfg, cfg)
})

test('traceSourceReport：**每源必有一行**——ok → source/end，失败 → source/error', () => {
  const path = join(tmp, 'invariant', 'freelance-radar-trace.jsonl')
  const ok = { source: 'eleduck', ok: true, raw: 10, hits: 6, stats: { raw: 10, kept: 6, dropped: 4, reasons: { 'bad-entry': 4 } }, durationMs: 120 }
  const bad = { source: 'remoteok', ok: false, raw: 0, hits: 0, stats: emptyStats(), failure: 'http-5xx', error: 'HTTP 503', durationMs: 88 }
  traceSourceReport(ok, { path, now: 1, pid: 1 })
  traceSourceReport(bad, { path, now: 2, pid: 1 })
  const lines = readTraceEntries(path)
  assert.deepEqual(lines.map((l) => l.phase), ['source/end', 'source/error'])
  assert.deepEqual(lines[0].reasons, { 'bad-entry': 4 })
  assert.equal(lines[0].dropped, 4)
  assert.equal(lines[1].failure, 'http-5xx')
  assert.equal(lines[1].error, 'HTTP 503')
  assert.equal(lines[1].hits, 0)
})

// ---------- 清洗依据（Q4：脏数据丢弃数） ----------

test('parseEleduckPostsDetailed：bad-entry / duplicate 分开计数；薄委托零漂移', () => {
  const posts = [
    { id: '1', title: 'A' },
    { id: '1', title: 'A-dup' },
    { id: '2', title: '   ' },      // 标题空 → bad-entry
    { title: 'no-id' },             // 缺 id → bad-entry
    { id: '3', title: 'C' },
  ]
  const { jobs, stats } = parseEleduckPostsDetailed(posts)
  assert.deepEqual(jobs.map((j) => j.id), ['eleduck-1', 'eleduck-3'])
  assert.equal(stats.raw, 5)
  assert.equal(stats.kept, 2)
  assert.equal(stats.dropped, 3)
  assert.deepEqual(stats.reasons, { duplicate: 1, 'bad-entry': 2 })
  // 薄委托：只比结构（同 id 序列、同条数），不比 publishedAt——本 fixture 的条目无 date
  // ⇒ toIso 兜底取「当前时间」，两次调用天然差毫秒（同形状抖动共 4 处，本日已全部改为结构比对）。
  const ePlain = parseEleduckPosts(posts)
  assert.deepEqual(ePlain.map((j) => j.id), jobs.map((j) => j.id))
  assert.equal(ePlain.length, jobs.length)
})

test('parseRemoteOkDetailed：metadata / non-tech / bad-entry / duplicate 四类依据', () => {
  const data = [
    { last_updated: 'x', legal: 'y' },                              // [0] metadata
    { slug: 'a', position: 'Senior Backend Engineer' },             // kept
    { slug: 'b', position: 'Delivery Driver' },                     // non-tech（真非技术岗）
    { position: 'no-slug engineer' },                               // bad-entry
    { slug: 'a', position: 'Senior Backend Engineer' },             // duplicate
  ]
  const { jobs, stats } = parseRemoteOkDetailed(data)
  assert.deepEqual(jobs.map((j) => j.id), ['remoteok-a'])
  assert.equal(stats.raw, 5)
  assert.equal(stats.kept, 1)
  assert.equal(stats.dropped, 4)
  assert.deepEqual(stats.reasons, { metadata: 1, 'non-tech': 1, 'bad-entry': 1, duplicate: 1 })
  // 薄委托断言：只比**结构**（同 id、同条数）——不比 publishedAt。
  // 该 fixture 的保留条目没有 date ⇒ toIso 兜底取「当前时间」，两次调用天然差毫秒
  // （实测 `…53.431Z` vs `…53.430Z` 假红）。兜底语义由下面带注入时钟的用例单测定死。
  const plain = parseRemoteOk(data)
  assert.deepEqual(plain.map((j) => j.id), jobs.map((j) => j.id))
  assert.equal(plain.length, jobs.length)
  assert.deepEqual(parseRemoteOkDetailed([]).stats, { raw: 0, kept: 0, dropped: 0 })   // 空数组：不误记 metadata
})

test('toIso：时钟可注入 ⇒ 兜底语义确定可测（缺日期/非法日期都回落到注入的 now）', () => {
  const NOW = 1789355521631
  assert.equal(toIso(undefined, NOW), new Date(NOW).toISOString())
  assert.equal(toIso('', NOW), new Date(NOW).toISOString())
  assert.equal(toIso('not-a-date', NOW), new Date(NOW).toISOString())
  // 合法日期不受 now 影响（注入时钟不得篡改真值）
  assert.equal(toIso('2026-01-02T03:04:05.000Z', NOW), '2026-01-02T03:04:05.000Z')
  // 同一输入 + 同一注入时钟 ⇒ 纯函数逐字可复现（这正是上面那条假红的根因）
  assert.equal(toIso(undefined, NOW), toIso(undefined, NOW))
})

test('parseRemoteOk 的技术岗过滤是**子串**判定（真语义，非缺陷但会误收）', () => {
  // TECH_RE 含两字母词元 `ai`/`ml`/`qa`，在长单词里会命中：Maint**ai**nance / M**ai**l …
  // → 「Hotel Maintenance Technician」这类非技术岗会被留下。登记为已知语义（见 docs/semantic.md §10）。
  const { jobs, stats } = parseRemoteOkDetailed([
    { legal: 'x' },
    { slug: 'h', position: 'Hotel Maintenance Technician' },
    { slug: 'd', position: 'Delivery Driver' },
  ])
  assert.deepEqual(jobs.map((j) => j.id), ['remoteok-h'])
  assert.equal(stats.reasons['non-tech'], 1)
})

test('parseRemotiveDetailed / parseWwrRssDetailed：坏条目与去重都留依据', () => {
  const remotive = [
    { id: 1, title: 'Dev', url: 'https://r/1' },
    { id: 1, title: 'Dev', url: 'https://r/1' },     // duplicate
    { title: 'no-url' },                              // bad-entry
  ]
  const r = parseRemotiveDetailed(remotive)
  assert.equal(r.jobs.length, 1)
  assert.deepEqual(r.stats.reasons, { duplicate: 1, 'bad-entry': 1 })
  // 薄委托：比结构不比 publishedAt（fixture 无日期 ⇒ toIso 兜底取当前时间，两次调用差毫秒）
  const rPlain = parseRemotive(remotive)
  assert.deepEqual(rPlain.map((j) => j.id), r.jobs.map((j) => j.id))
  assert.equal(rPlain.length, r.jobs.length)

  const xml = [
    '<rss>',
    '<item><title>A</title><link>https://w/1</link></item>',
    '<item><title>A</title><link>https://w/1</link></item>',       // duplicate（id 由 title 派生）
    '<item><title>B</title></item>',                               // bad-item（缺 link）
    '<item><title>  </title><link>https://w/3</link></item>',      // empty（标题空白）
    '</rss>',
  ].join('')
  const w = parseWwrRssDetailed(xml)
  assert.deepEqual(w.jobs.map((j) => j.url), ['https://w/1'])
  assert.equal(w.stats.raw, 4)
  assert.equal(w.stats.kept, 1)
  assert.deepEqual(w.stats.reasons, { duplicate: 1, 'bad-item': 1, empty: 1 })
  // 同上：薄委托只比结构（url 集合），不比 publishedAt（fixture 无 pubDate ⇒ 兜底取当前时间）
  const wPlain = parseWwrRss(xml)
  assert.deepEqual(wPlain.map((j) => j.url), w.jobs.map((j) => j.url))
  assert.equal(wPlain.length, w.jobs.length)
})

// ---------- 接线测试：真 apply + 假 ctx + fetch 桩 ----------

/** fetch 桩：按 URL 分派四个源（含「一个源 HTTP 500」的样本）。 */
function stubFetch({ failRemoteOk = false, dirtyEleduck = false, nullEleduck = false } = {}) {
  return async (url) => {
    const u = String(url)
    if (u.includes('/posts?category=5')) {
      const posts = nullEleduck
        ? [{ id: '1', title: 'A' }, null]
        : dirtyEleduck
          ? [{ id: '1', title: 'A' }, { id: '2', title: '   ' }, { title: 'no-id' }]
          : [{ id: '1', title: 'A' }, { id: '2', title: 'B' }]
      return { ok: true, status: 200, json: async () => ({ posts }), text: async () => '' }
    }
    if (u.includes('remoteok.com')) {
      if (failRemoteOk) return { ok: false, status: 503, json: async () => ({}), text: async () => '' }
      return { ok: true, status: 200, json: async () => ([{ legal: 'x' }, { slug: 's', position: 'ML Engineer' }]), text: async () => '' }
    }
    if (u.includes('remotive.com')) {
      return { ok: true, status: 200, json: async () => ({ jobs: [{ id: 1, title: 'Dev', url: 'https://r/1' }] }), text: async () => '' }
    }
    if (u.includes('weworkremotely.com')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<rss><item><title>W</title><link>https://w/1</link></item></rss>' }
    }
    throw new Error('unexpected url ' + u)
  }
}

function makeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      tools: { register: (t) => { registered.push(t); return () => {} } },
      effect: () => () => {},
    },
  }
}

async function runScan(name, stub) {
  const dir = join(tmp, name)
  process.env['DSH_HOME'] = dir
  const { ctx, registered } = makeCtx()
  apply(ctx, { enabled: true, dataDir: join(dir, 'freelance-radar'), eleduckApiBase: 'https://svc.eleduck.com/api/v1' })
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    const tool = registered.find((t) => t.name === 'radar_scan')
    return await tool.execute({})
  } finally {
    globalThis.fetch = original
  }
}

test('接线：一轮扫描 = boot + scan/start + **四个源各一行** + scan/end（入库闭环可读）', async () => {
  const out = await runScan('wired-ok', stubFetch())
  assert.equal(out.ok, true)
  const lines = readTraceEntries(radarTracePath(join(tmp, 'wired-ok')))
  assert.deepEqual(lines.map((l) => l.phase), ['boot', 'scan/start', 'source/end', 'source/end', 'source/end', 'source/end', 'scan/end'])
  assert.deepEqual(lines.slice(2, 6).map((l) => l.source), ['eleduck', 'remoteok', 'remotive', 'wwr'])
  const end = lines[6]
  assert.equal(end.fetched, out.added)          // 首轮全部新增：eleduck 2 + remoteok 1 + remotive 1 + wwr 1
  assert.equal(end.added, 5)
  assert.equal(end.dups, 0)
  assert.equal(end.live, 5)
  assert.equal(end.sourcesOk, 4)
  assert.equal(end.sourcesFailed, 0)
  assert.equal(typeof end.durationMs, 'number')
})

test('接线：一个源 HTTP 503 → **它有一行 source/error**（不再静默消失），其余源照常入库', async () => {
  const out = await runScan('wired-fail', stubFetch({ failRemoteOk: true }))
  assert.equal(out.ok, true)
  const lines = readTraceEntries(radarTracePath(join(tmp, 'wired-fail')))
  const sources = lines.filter((l) => l.source !== undefined)
  assert.equal(sources.length, 4)                                  // 不变式：源几个，行几条
  const bad = sources.find((l) => l.source === 'remoteok')
  assert.equal(bad.phase, 'source/error')
  assert.equal(bad.failure, 'http-5xx')
  assert.equal(bad.error, 'HTTP 503')
  assert.equal(bad.hits, 0)
  const end = lines.find((l) => l.phase === 'scan/end')
  assert.equal(end.sourcesOk, 3)
  assert.equal(end.sourcesFailed, 1)                               // 一眼看出「源挂了」而非「没新任务」
  assert.equal(end.added, 4)                                       // remoteok 那 1 条丢了，其余源照常
})

test('接线：脏条目只丢该条、不吞整源（脏数据丢弃数可读）', async () => {
  const out = await runScan('wired-dirty', stubFetch({ dirtyEleduck: true }))
  assert.equal(out.ok, true)
  const lines = readTraceEntries(radarTracePath(join(tmp, 'wired-dirty')))
  const eleduck = lines.find((l) => l.source === 'eleduck')
  assert.equal(eleduck.raw, 3)
  assert.equal(eleduck.hits, 1)
  assert.equal(eleduck.dropped, 2)
  assert.deepEqual(eleduck.reasons, { 'bad-entry': 2 })
  assert.equal(lines.find((l) => l.phase === 'scan/end').sourcesFailed, 0)
})

test('接线：第二轮同数据 → added=0 且 dups 可见（「今天没新任务」也可解释）', async () => {
  await runScan('wired-twice', stubFetch())
  const out = await runScan('wired-twice', stubFetch())            // 同一 dataDir → 状态复用
  const lines = readTraceEntries(radarTracePath(join(tmp, 'wired-twice')))
  const ends = lines.filter((l) => l.phase === 'scan/end')
  assert.equal(out.added, 0)
  assert.equal(ends.length, 2)
  assert.equal(ends[1].added, 0)
  assert.equal(ends[1].fetched, 5)
  assert.equal(ends[1].dups, 5)
  assert.equal(ends[1].sourcesFailed, 0)                           // added=0 且 failures=0 ⇒ 确实没新任务
})

test('接线：源返回 null 元素（旧实现抛 TypeError → allSettled 静默丢整源）→ 现在必有一行 source/error', async () => {
  const out = await runScan('wired-null', stubFetch({ nullEleduck: true }))
  assert.equal(out.ok, true)
  const lines = readTraceEntries(radarTracePath(join(tmp, 'wired-null')))
  const sources = lines.filter((l) => l.source !== undefined)
  assert.equal(sources.length, 4)                                  // 不变式仍成立
  const eleduck = sources.find((l) => l.source === 'eleduck')
  assert.equal(eleduck.phase, 'source/error')                      // 旧实现：整源无声消失
  assert.equal(eleduck.failure, 'unknown')                         // TypeError 文案不可分类 → 诚实标 unknown
  assert.match(eleduck.error, /null/)
  assert.equal(eleduck.hits, 0)
  const end = lines.find((l) => l.phase === 'scan/end')
  assert.equal(end.sourcesFailed, 1)                               // 一眼看出：有源死了，不是没新任务
  assert.equal(end.sourcesOk, 3)
})

test('尸体测试（接线级）：DSH_HOME 不可写时扫描照常返回（观测不反噬）', async () => {
  const blocker = join(tmp, 'blocker-wired')
  writeFileSync(blocker, 'not a dir', 'utf8')
  process.env['DSH_HOME'] = join(blocker, 'nope')
  const { ctx, registered } = makeCtx()
  apply(ctx, { enabled: true, dataDir: join(blocker, 'nope', 'freelance-radar') })
  const original = globalThis.fetch
  globalThis.fetch = stubFetch()
  try {
    const tool = registered.find((t) => t.name === 'radar_scan')
    const out = await tool.execute({})
    assert.equal(out.ok, true)                                     // 轨迹写不进去，扫描结果不受影响
    assert.equal(out.added, 5)
  } finally {
    globalThis.fetch = original
    process.env['DSH_HOME'] = join(tmp, 'home')
  }
})

// ---------- 最近扫描时刻（停摆可见性，2026-09-14） ----------

test('lastScanAtMs：只认 scan/* 相位并取最大 atMs——boot/source 行不算「扫过」', () => {
  assert.equal(lastScanAtMs([]), null)
  // 只有 boot（进程启动）与 source 行（抓取细节）→ 判「没扫过」，不得把启动当扫描
  assert.equal(lastScanAtMs([base({ phase: 'boot' }), base({ phase: 'source/end' })]), null)
  const entries = [
    base({ phase: 'boot', atMs: 5_000 }),
    base({ phase: 'scan/start', atMs: 1_000 }),
    base({ phase: 'scan/end', atMs: 2_000 }),
    base({ phase: 'scan/start', atMs: 9_000 }),
    base({ phase: 'source/error', atMs: 9_500 }),   // 更晚，但不是扫描相位
  ]
  assert.equal(lastScanAtMs(entries), 9_000)
  assert.equal(lastScanAtMs([base({ phase: 'scan/end', atMs: Number.NaN })]), null, '脏 atMs 不算数')
})

test('退化：lastScanAt 喂缺失文件/坏行 → null（诊断入口不抛）', () => {
  assert.equal(lastScanAt(join(tmp, 'no-such-trace-file.jsonl')), null)
  const p = join(tmp, 'partial-scan-trace.jsonl')
  writeFileSync(p, '{"atMs":1700000000000,"phase":"scan/end"}\nnot-json\n{"phase":"scan/start"}\n', 'utf8')
  assert.equal(lastScanAt(p), 1_700_000_000_000, '坏行跳过；第三行缺 atMs 被解析层丢弃')
})

test('接线：radar_digest 主动说出「距上次扫描 N 天」——手动模式的停摆不再无声', async () => {
  const home = join(tmp, 'digest-stale')
  process.env['DSH_HOME'] = home
  const { ctx, registered } = makeCtx()
  apply(ctx, { enabled: true, dataDir: join(home, 'freelance-radar') })
  const digest = registered.find((t) => t.name === 'radar_digest')

  // ① 只有 apply 自己写的 boot 行 → 「无扫描记录」（不得把进程启动过当成扫过）
  const fresh = await digest.execute({})
  assert.equal(fresh.staleDays, -1)
  assert.equal(fresh.lastScanAt, '')
  assert.match(digest.output.render({}, fresh)[0].text, /无记录/)

  // ② 补一行 9 天前的 scan/end → staleDays=9 且 render 响亮告警（阈值 7 天）
  const nineDaysAgo = Date.now() - 9 * 86400000
  writeFileSync(radarTracePath(home), JSON.stringify(base({ phase: 'scan/end', atMs: nineDaysAgo })) + '\n', 'utf8')
  const stale = await digest.execute({})
  assert.equal(stale.staleDays, 9)
  assert.match(stale.summary, /距上次扫描 9 天/)
  assert.match(digest.output.render({}, stale)[0].text, /⚠ 距上次扫描 9 天/)
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
