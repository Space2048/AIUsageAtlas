import { chromium } from 'playwright'

// 用法: node scripts/diag-pagination.mjs <profileDir>
const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('用法: node scripts/diag-pagination.mjs <profileDir>')
  process.exit(1)
}
const BASE = 'https://platform.stepfun.com'
const RPC = '/api/step.openapi.devcenter.Dashboard/'

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true })
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(`${BASE}/step-plan`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(6000)

const call = (method, body) =>
  page
    .evaluate(
      async ([m, b]) => {
        const r = await fetch(m, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'connect-protocol-version': '1',
            'oasis-appid': '10300',
            'oasis-platform': 'web',
          },
          body: JSON.stringify(b),
          credentials: 'include',
        })
        return { status: r.status, json: await r.json().catch(() => null) }
      },
      [RPC + method, body]
    )
    .catch((e) => ({ status: -1, json: null, err: e.message }))

const now = Math.floor(Date.now() / 1000)
const start90 = (now - 90 * 86400) * 1000
const endMs = now * 1000

// 逐页拉取，观察 total 语义与页数
let pageNo = 1
let all = []
for (let i = 0; i < 30; i++) {
  const r = await call('QueryStepPlanUsages', { start_time: start90, to_time: endMs, page: pageNo, page_size: 100 })
  const recs = r.json?.records ?? []
  all = all.concat(recs)
  console.log(`page ${pageNo}: status=${r.status} records=${recs.length} total=${r.json?.total}`)
  if (recs.length === 0) break
  if (typeof r.json?.total === 'number' && all.length >= r.json.total) break
  pageNo++
}

console.log('\n总记录数:', all.length)
const byModel = new Map()
for (const rec of all) {
  const k = rec.model_id || '?'
  const c = byModel.get(k) ?? { tokens: 0, credits: 0, calls: 0 }
  c.tokens += Number(rec.in_amount || 0) + Number(rec.out_amount || 0) + Number(rec.cache_amount || 0)
  c.credits += Number(rec.credit_consumed || 0)
  c.calls += Number(rec.calls || 0)
  byModel.set(k, c)
}
console.log('按模型汇总:')
for (const [m, c] of [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${m}: tokens=${(c.tokens / 1e6).toFixed(1)}M credits=${(c.credits / 1e6).toFixed(1)}M calls=${c.calls}`)
}

// 时间范围对比：30天 vs 90天
for (const days of [7, 30, 90]) {
  const r = await call('QueryStepPlanUsages', {
    start_time: (now - days * 86400) * 1000,
    to_time: endMs,
    page: 1,
    page_size: 1,
  })
  console.log(`近${days}天 total:`, r.json?.total)
}

// RateLimit 对照
const rl = await call('QueryStepPlanRateLimit', {})
console.log('\nRateLimit buckets:', JSON.stringify(rl.json?.plan_credit_rate_limit?.credit_buckets))

await ctx.close()
