import { chromium } from 'playwright'

// 用法: node scripts/diag-usage.mjs <profileDir>
const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('用法: node scripts/diag-usage.mjs <profileDir>')
  process.exit(1)
}
const BASE = 'https://platform.stepfun.com'
const RPC = '/api/step.openapi.devcenter.Dashboard/'

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true })
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(`${BASE}/step-plan`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(6000)

// 1. token 是否被前端自动续期
const token = (await ctx.cookies(BASE)).find((c) => c.name === 'Oasis-Token')?.value || ''
if (token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    console.log('token create:', new Date(p.create_at * 1000).toISOString(), 'exp:', new Date(p.exp * 1000).toISOString())
  } catch {
    console.log('token 非 JWT')
  }
} else {
  console.log('!! 无 token（会话已失效，需重新登录）')
}

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
        return { status: r.status, text: await r.text() }
      },
      [RPC + method, body]
    )
    .catch((e) => ({ status: -1, text: e.message }))

const now = Math.floor(Date.now() / 1000)

// 2. GetStepPlanStatus 全字段（找刷新时间）
const st = await call('GetStepPlanStatus', {})
console.log('\n=== GetStepPlanStatus ===')
console.log(st.text.slice(0, 1500))

// 3. QueryStepPlanUsages 参数组合
console.log('\n=== QueryStepPlanUsages 参数组合 ===')
const combos = [
  { start_time: now - 30 * 86400, to_time: now, page: 1, page_size: 20 },
  { start_time: now - 30 * 86400, to_time: now, page: 1, page_size: 20, merge_by_time: 1 },
  { start_time: now - 30 * 86400, to_time: now, page: 1, page_size: 20, granular_hour: 24 },
  { start_time: now - 30 * 86400, to_time: now, page: 1, page_size: 20, granular_hour: 1 },
  { start_time: (now - 30 * 86400) * 1000, to_time: now * 1000, page: 1, page_size: 20 },
]
for (const [i, c] of combos.entries()) {
  const r = await call('QueryStepPlanUsages', c)
  console.log(`组合${i}:`, JSON.stringify(c).slice(0, 110))
  console.log('  ->', r.status, r.text.slice(0, 400))
}

// 4. RateLimit（可能有重置信息）
const rl = await call('QueryStepPlanRateLimit', {})
console.log('\n=== QueryStepPlanRateLimit ===')
console.log(rl.status, rl.text.slice(0, 800))

// 5. 按量 DevQueryUsageHistory 对照
const dev = await call('DevQueryUsageHistory', { fromTime: now - 30 * 86400, toTime: now, pageSize: 20, page: 1 })
console.log('\n=== DevQueryUsageHistory (无 quotaType) ===')
console.log(dev.status, dev.text.slice(0, 500))

await ctx.close()
