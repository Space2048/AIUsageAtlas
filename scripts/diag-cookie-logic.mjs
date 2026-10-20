import { chromium } from 'playwright'

// 用法: node scripts/diag-cookie-logic.mjs <profileDir>
// profileDir 形如 .data/browser-profiles/<providerId>，不写死以免把本机路径和账号 ID 带进仓库
const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('用法: node scripts/diag-cookie-logic.mjs <profileDir>')
  process.exit(1)
}
const BASE = 'https://platform.stepfun.com'

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true })
const page = ctx.pages()[0] ?? (await ctx.newPage())

// 1. 所有 cookie（含 HttpOnly），看有没有长效凭证
const cookies = await ctx.cookies()
console.log('=== 全部 cookies ===')
for (const c of cookies) {
  const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session(关浏览器即失)'
  console.log(`  ${c.domain}${c.path} ${c.name} httpOnly=${c.httpOnly} secure=${c.secure} exp=${exp} len=${c.value.length}`)
}

// 2. 打开控制台，看 IndexedDB / 更多存储
await page.goto(`${BASE}/step-plan`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
await page.waitForTimeout(6000)

const dbs = await page.evaluate(async () => {
  const out = []
  try {
    for (const d of await indexedDB.databases()) {
      const entry = { name: d.name, version: d.version, stores: [], sample: [] }
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open(d.name)
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        entry.stores = [...db.objectStoreNames]
        for (const s of db.objectStoreNames) {
          try {
            const tx = db.transaction(s, 'readonly')
            const req = tx.objectStore(s).getAll()
            const items = await new Promise((res) => {
              req.onsuccess = () => res(req.result)
              req.onerror = () => res([])
            })
            entry.sample.push({
              store: s,
              count: items.length,
              keys: items.slice(0, 3).map((i) => JSON.stringify(i).slice(0, 160)),
            })
          } catch { /* ignore */ }
        }
        db.close()
      } catch { /* ignore */ }
      out.push(entry)
    }
  } catch (e) {
    out.push({ error: String(e) })
  }
  return out
})
console.log('\n=== IndexedDB ===')
console.log(JSON.stringify(dbs, null, 1).slice(0, 2500))

// 3. localStorage 全量 key + 值前缀
const ls = await page.evaluate(() => {
  const o = {}
  for (const k of Object.keys(localStorage)) o[k] = (localStorage.getItem(k) || '').slice(0, 80)
  return o
})
console.log('\n=== localStorage ===')
console.log(JSON.stringify(ls, null, 1))

// 4. 观察前端自己的续期行为：等 90 秒看 token cookie 是否变化
const before = (await ctx.cookies(BASE)).find((c) => c.name === 'Oasis-Token')?.value
console.log('\n等待 90 秒观察 token 是否被前端自动轮换…')
await page.waitForTimeout(90000)
const after = (await ctx.cookies(BASE)).find((c) => c.name === 'Oasis-Token')?.value
console.log('token 变化:', !before ? '(之前无)' : !after ? '(现在无)' : before === after ? '未变化' : '已轮换!')

await ctx.close()
