/**
 * sources.ts 纯函数套件（离线、零网络）。
 * 覆盖：正常路径 + 失败/退化路径（脏数据、空数组、缺字段、非法日期、重复项）。
 * 失败路径是 S6 判据——源返回脏数据时解析器必须**保守返回**，不得抛错拖垮整源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripHtml, eleduckToJob, parseEleduckPosts,
  remoteOkToJob, parseRemoteOk, TECH_RE,
  remotiveToJob, parseRemotive, parseWwrRss,
} from '../lib/sources.js'

// ---------- stripHtml ----------

test('stripHtml: 去标签 + 解码实体 + 折叠空白', () => {
  assert.equal(stripHtml('<p>Hello &amp; <b>world</b></p>\n\n<i>a&nbsp;b</i>'), 'Hello & world a b')
  assert.equal(stripHtml('&lt;tag&gt; &quot;q&quot;'), '<tag> "q"')
})

test('stripHtml: 退化输入——undefined / 空串 / 纯标签', () => {
  assert.equal(stripHtml(undefined), '')
  assert.equal(stripHtml(''), '')
  assert.equal(stripHtml('<div></div>'), '')
})

// ---------- eleduck ----------

test('eleduckToJob: 正常映射（full_title 优先、tags 取 name、closed 透传）', () => {
  const job = eleduckToJob({
    id: '42', title: 'short', full_title: '  Full Title  ',
    summary: '<p>sum</p>', content: '<div>body</div>', closed: true,
    published_at: '2026-09-01T00:00:00.000Z',
    tags: [{ id: 17, name: '远程工作' }, { id: 18 }],
  })
  assert.equal(job.id, 'eleduck-42')
  assert.equal(job.title, 'Full Title')
  assert.equal(job.url, 'https://eleduck.com/posts/42')
  assert.equal(job.source, 'eleduck')
  assert.deepEqual(job.tags, ['远程工作'])
  assert.equal(job.closed, true)
  assert.equal(job.summary, 'sum')
  assert.equal(job.content, 'body')
})

test('eleduckToJob: 失败/退化路径——缺 id/title、类型不符、空标题一律 null（不抛）', () => {
  assert.equal(eleduckToJob({}), null)
  assert.equal(eleduckToJob({ id: '1' }), null)
  assert.equal(eleduckToJob({ title: 'x' }), null)
  assert.equal(eleduckToJob({ id: 1, title: 'x' }), null)          // 类型不符（number）
  assert.equal(eleduckToJob({ id: '1', title: '   ' }), null)       // 空白标题
  assert.deepEqual(eleduckToJob({ id: '1', title: 'x', tags: undefined }).tags, [], 'tags 缺失 → 空数组')
})

test('eleduckToJob: 摘要降级——summary 空则回落 content 前 300 字，published_at 缺失回落当前时间', () => {
  const job = eleduckToJob({ id: '9', title: 'T', content: 'C-body' })
  assert.equal(job.summary, 'C-body')
  assert.equal(Number.isNaN(new Date(job.publishedAt).getTime()), false)
})

test('parseEleduckPosts: 同 id 去重（保留首现）+ 坏条目跳过 + 空数组', () => {
  const jobs = parseEleduckPosts([
    { id: '1', title: 'A' }, { id: '1', title: 'A-dup' }, { title: 'no-id' }, { id: '2', title: 'B' },
  ])
  assert.deepEqual(jobs.map((j) => j.title), ['A', 'B'])
  assert.deepEqual(parseEleduckPosts([]), [])
})

// ---------- RemoteOK ----------

test('remoteOkToJob: 正常映射 + company 后缀 + 非字符串 tags 过滤', () => {
  const job = remoteOkToJob({
    slug: 's1', position: ' Senior Engineer ', company: 'ACME',
    tags: ['ai', 7], description: '<p>desc</p>', date: '2026-09-01T00:00:00.000Z',
  })
  assert.equal(job.title, 'Senior Engineer @ ACME')
  assert.equal(job.id, 'remoteok-s1')
  assert.deepEqual(job.tags, ['ai'])
  assert.equal(job.url, 'https://remoteok.com/remote-jobs/s1')
})

test('remoteOkToJob: 失败路径——缺 slug/position 或空 position → null', () => {
  assert.equal(remoteOkToJob({}), null)
  assert.equal(remoteOkToJob({ slug: 's' }), null)
  assert.equal(remoteOkToJob({ position: 'x' }), null)
  assert.equal(remoteOkToJob({ slug: 's', position: '  ' }), null)
})

test('remoteOkToJob: 脏数据路径——非法日期不得抛错（整源会因此被 Promise.allSettled 丢弃）', () => {
  const job = remoteOkToJob({ slug: 's', position: 'Engineer', date: 'garbage' })
  assert.ok(job, '脏日期条目应仍产出 Job，而不是抛 RangeError')
  assert.equal(Number.isNaN(new Date(job.publishedAt).getTime()), false, 'publishedAt 必须是合法 ISO')
})

test('parseRemoteOk: 跳过 [0] metadata + 非技术岗过滤 + 去重 + 空数组', () => {
  const out = parseRemoteOk([
    { last_updated: 'x' },
    { slug: 'a', position: 'Backend Engineer' },
    { slug: 'a', position: 'Backend Engineer' },
    { slug: 'b', position: 'Hotel Maintenance' },   // 见下方「已知过宽」注释：'ai' 命中 "mAIntenance"
    { slug: 'c', position: 'Product Manager' },
    { slug: 'd', position: 'Warehouse Picker' },
  ])
  // 预期 = 真实语义：TECH_RE 是无词界的子串匹配（'ai'/'ml'/'dev' 会命中 maintenance/devops 之外的词），
  // 所以 'Hotel Maintenance' 因含 "ai" 被放行——这是**已知的过滤过宽**（噪音岗漏网），
  // 不是测试写错；收紧会改变筛选行为，故本次只登记不改（见 docs/semantic.md §10）。
  assert.deepEqual(out.map((j) => j.id), ['remoteok-a', 'remoteok-b', 'remoteok-c'])
  assert.deepEqual(parseRemoteOk([]), [])
  assert.deepEqual(parseRemoteOk([{ last_updated: 'x' }]), [], '只有 metadata 时必须返回空数组')
  assert.equal(TECH_RE.test('Data Scientist'), true)
  assert.equal(TECH_RE.test('Warehouse Picker'), false, '完全无关岗位必须被拦下（过滤下限仍在）')
})

test('parseRemoteOk: 脏日期条目不得拖垮整批（返回其余条目）', () => {
  const out = parseRemoteOk([
    {},
    { slug: 'good', position: 'AI Engineer' },
    { slug: 'bad', position: 'Software Developer', date: 'not-a-date' },
  ])
  assert.deepEqual(out.map((j) => j.id), ['remoteok-good', 'remoteok-bad'])
})

// ---------- Remotive ----------

test('remotiveToJob: 正常映射 + tags 合并（category/tags/job_type/location）', () => {
  const job = remotiveToJob({
    id: 5, title: ' Dev ', url: 'https://r/5', company_name: 'ACME', category: 'Dev',
    tags: ['ai', ''], job_type: 'full_time', candidate_required_location: 'Anywhere',
    publication_date: '2026-09-02T00:00:00.000Z', description: '<p>d</p>',
  })
  assert.equal(job.title, 'Dev @ ACME', 'title 先 trim 再拼 company（真实语义，勿写成 " Dev @ ACME"）')
  assert.equal(job.id, 'remotive-5')
  assert.deepEqual(job.tags, ['Dev', 'ai', 'full_time', 'Anywhere'])
})

test('remotiveToJob: 失败路径——缺 title/url、空标题、id 缺失时回落标题', () => {
  assert.equal(remotiveToJob({}), null)
  assert.equal(remotiveToJob({ title: 'x' }), null)
  assert.equal(remotiveToJob({ url: 'u' }), null)
  assert.equal(remotiveToJob({ title: '  ', url: 'u' }), null)
  assert.equal(remotiveToJob({ title: 'x', url: 'u' }).id, 'remotive-x')
})

test('remotiveToJob: 脏数据路径——非法 publication_date 不得抛错', () => {
  const job = remotiveToJob({ title: 'x', url: 'u', publication_date: 'nope' })
  assert.ok(job)
  assert.equal(Number.isNaN(new Date(job.publishedAt).getTime()), false)
})

test('parseRemotive: 去重 + 坏条目跳过 + 空数组', () => {
  const out = parseRemotive([{ id: 1, title: 'A', url: 'u1' }, { id: 1, title: 'A2', url: 'u2' }, { title: 'bad' }])
  assert.deepEqual(out.map((j) => j.title), ['A'])
  assert.deepEqual(parseRemotive([]), [])
})

// ---------- WeWorkRemotely RSS ----------

test('parseWwrRss: 解析 item（标题/链接/描述/pubDate）', () => {
  const xml = '<rss><item><title>AI Engineer</title><link>https://w/1</link>'
    + '<description>&lt;p&gt;hello&lt;/p&gt;</description><pubDate>2026-09-03T00:00:00.000Z</pubDate></item></rss>'
  const jobs = parseWwrRss(xml)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].title, 'AI Engineer')
  assert.equal(jobs[0].url, 'https://w/1')
  assert.equal(jobs[0].source, 'wwr')
  assert.deepEqual(jobs[0].tags, ['远程'])
})

test('parseWwrRss: 退化路径——空串/无 item/缺 title 或 link 的条目跳过', () => {
  assert.deepEqual(parseWwrRss(''), [])
  assert.deepEqual(parseWwrRss('<rss></rss>'), [])
  assert.deepEqual(parseWwrRss('<item><link>https://w/1</link></item>'), [])
  assert.deepEqual(parseWwrRss('<item><title>T</title></item>'), [])
  assert.deepEqual(parseWwrRss('<item><title>  </title><link>u</link></item>'), [])
})

test('parseWwrRss: 同 title 去重（id 由 title 前 60 字派生）', () => {
  const item = '<item><title>Same</title><link>u</link></item>'
  assert.equal(parseWwrRss(item + item).length, 1)
})

test('parseWwrRss: 脏数据路径——非法 pubDate 不得抛错', () => {
  const jobs = parseWwrRss('<item><title>T</title><link>u</link><pubDate>garbage</pubDate></item>')
  assert.equal(jobs.length, 1)
  assert.equal(Number.isNaN(new Date(jobs[0].publishedAt).getTime()), false)
})
