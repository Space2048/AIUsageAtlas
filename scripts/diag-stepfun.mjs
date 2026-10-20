// 诊断脚本：抓 StepFun 控制台前端自发的 RPC 请求头，对比裸 fetch
// 用法: node scripts/diag-stepfun.mjs <profileDir>
import { chromium } from 'playwright'

const profileDir = process.argv[2]
if (!profileDir) {
  console.error('用法: node scripts/diag-stepfun.mjs <profileDir>')
  process.exit(1)
}

const RPC = '/api/step.openapi.devcenter.Dashboard/'

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1280, height: 800 },
})

const page = context.pages()[0] ?? (await context.newPage())

page.on('request', (req) => {
  if (req.url().includes(RPC)) {
    console.log('=== 前端自发 RPC 请求 ===')
    console.log('URL:', req.url())
    console.log('方法:', req.method())
    const h = req.headers()
    for (const k of Object.keys(h)) {
      const v = h[k]
      console.log(`  ${k}: ${v.length > 80 ? v.slice(0, 80) + `… (len ${v.length})` : v}`)
    }
    if (req.postData()) console.log('  body:', req.postData().slice(0, 200))
  }
})

page.on('response', async (res) => {
  if (res.url().includes(RPC)) {
    console.log('=== RPC 响应 ===', res.url().split('/').pop(), '->', res.status())
    const body = await res.text().catch(() => '')
    console.log('  body:', body.slice(0, 300))
  }
})

console.log('打开控制台 /step-plan …')
await page.goto('https://platform.stepfun.com/step-plan', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(8000)
console.log('当前 URL:', page.url())

// 再用裸 fetch 打一次，看差异
console.log('\n=== 我们的裸 fetch ===')
const raw = await page.evaluate(async () => {
  const res = await fetch('/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'include',
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 300) }
})
console.log('status:', raw.status)
console.log('body:', raw.body)

// 看看页面里的 cookie / storage
const env = await page.evaluate(() => ({
  cookie: document.cookie.slice(0, 200),
  hasOasisTokenCookie: document.cookie.includes('Oasis-Token'),
  localStorageKeys: Object.keys(localStorage).slice(0, 20),
  sessionStorageKeys: Object.keys(sessionStorage).slice(0, 20),
}))
console.log('\n=== 页面环境 ===')
console.log(JSON.stringify(env, null, 2))

await context.close()
