import { fetchJson } from '~~/server/utils/http'
import { normalizeCookie } from '~~/server/utils/cookie'
import { ensureProfileDir, isLoggedIn, markLoggedIn } from '~~/server/utils/browser-profile'
import { closeSession, ensureLivePage, isPageAlive, persistStorageState, snapshotSession, startKeepAlive } from '~~/server/utils/browser-session'
import {
  PluginError,
  type CredentialPayload,
  type PluginContext,
  type PluginFetchResult,
  type PluginLoginResult,
  type ProviderPlugin,
} from './types'

/**
 * Xiaomi MiMo（小米大模型开放平台）插件
 *
 * 域名事实（2026-10-20 实测）：推理 API 在 api.xiaomimimo.com，控制台在
 * platform.xiaomimimo.com；api.mimo.xiaomi.com / platform.mimo.xiaomi.com 均不解析。
 *
 * 取数策略：
 * 1. apikey —— 只有 GET /v1/models 可用作探活。平台没有对外计费/用量 API
 *    （/v1/dashboard/billing/*、/v1/usage 等一律 404），所以此模式拿不到余额。
 * 2. browser-login —— Playwright 持久 profile 登录一次，之后在页面上下文内调控制台
 *    /api/v1/* 接口（同源 + credentials 自动带 serviceToken）。
 * 3. cookie —— 直接带 Cookie 头请求控制台接口，作为无浏览器环境的退路。
 *
 * 控制台接口路径来自前端 bundle 的静态常量与第三方余额监控插件源码，
 * 官方文档未记载；响应字段结构在真实账号上验证前按候选名容错解析。
 */

const API_BASE = 'https://api.xiaomimimo.com'
const CONSOLE_BASE = 'https://platform.xiaomimimo.com'
const CONSOLE_PAGE = `${CONSOLE_BASE}/#/console/balance`

const EP = {
  balance: '/api/v1/balance',
  planUsage: '/api/v1/tokenPlan/usage',
  planDetail: '/api/v1/tokenPlan/detail',
  subStatus: '/api/v1/subscription/status',
  usageList: '/api/v1/usage/detail/list',
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

// 控制台接口统一包在 { code, msg, data } 里，个别端点直接返回裸对象
function unwrap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  const inner = obj.data ?? obj.result
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>
  return obj
}

// 时间戳/字符串统一成 YYYY-MM-DD；MiMo 各接口混用秒、毫秒和紧凑日期
function toDay(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
    const parsed = Date.parse(s)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
    return null
  }
  const n = num(v)
  if (n === undefined || n <= 0) return null
  const ms = n > 1e12 ? n : n < 1e11 ? n * 1000 : n
  return new Date(ms).toISOString().slice(0, 10)
}

function toIso(v: unknown): string | null {
  return toDay(v)
}

// ---------- 模式一：API Key 探活 ----------

interface MiModels {
  data?: Array<{ id?: string; owned_by?: string }>
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  let models: MiModels
  try {
    models = await fetchJson<MiModels>(`${API_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
    }
    throw new PluginError('network', `模型列表请求失败：${err.message}`)
  }
  const list = models.data ?? []
  if (!list.length) throw new PluginError('parse', '模型列表为空，Key 可能没有可用模型权限')

  // tp- / ttp- 前缀是 Token Plan 套餐密钥，sk- 是按量付费密钥
  const planKind = apiKey.startsWith('tp-') ? 'Token Plan（个人）' : apiKey.startsWith('ttp-') ? 'Token Plan（团队）' : '按量付费'
  ctx.log(`Key 可用，模型 ${list.length} 个`)

  return {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`,
      region: 'CN',
    },
    plan: { name: planKind, currency: 'CNY' },
    notes: [
      `可用模型 ${list.length} 个：${list.slice(0, 6).map((m) => m.id).filter(Boolean).join('、')}${list.length > 6 ? ' …' : ''}`,
      '平台未提供对外计费接口，余额与套餐额度需用浏览器登录或 Cookie 模式采集',
    ],
  }
}

// ---------- 控制台数据归一化 ----------

interface MiBalance {
  balance?: number | string
  cashBalance?: number | string
  giftBalance?: number | string
  currency?: string
}

function pickBalance(raw: unknown): { amount: number; currency: string } | undefined {
  const d = unwrap(raw) as MiBalance
  const amount = num(d.balance) ?? num(d.cashBalance)
  if (amount === undefined) return undefined
  return { amount, currency: d.currency || 'CNY' }
}

// tokenPlan/usage 的 items 可能是数组，也可能是以指标名为键的对象
interface MiPlanItem {
  name: string
  used: number
  limit: number
  pct: number
}

function pickPlanItems(raw: unknown): MiPlanItem[] {
  const d = unwrap(raw)
  const usage = (d.usage && typeof d.usage === 'object' ? d.usage : d) as Record<string, unknown>
  const items = usage.items ?? usage.plans
  const pairs: Array<[string, unknown]> = Array.isArray(items)
    ? items.map((it, i) => [String((it as Record<string, unknown>)?.name ?? (it as Record<string, unknown>)?.key ?? `item${i}`), it])
    : items && typeof items === 'object'
      ? Object.entries(items as Record<string, unknown>)
      : []

  const LABELS: Record<string, string> = {
    plan_total_token: '套餐 Credits',
    compensation_total_token: '补偿 Credits',
  }

  const out: MiPlanItem[] = []
  for (const [key, value] of pairs) {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const used = num(v.used) ?? num(v.usedValue) ?? num(v.total)
    const limit = num(v.limit) ?? num(v.limitValue) ?? num(v.totalQuota)
    let pct = num(v.percent) ?? num(v.usagePercent)
    if (used !== undefined && limit && limit > 0) pct = (used / limit) * 100
    if (pct === undefined || used === undefined || limit === undefined) continue
    if (pct <= 1 && limit > 1) pct *= 100
    out.push({ name: LABELS[key] ?? key, used, limit, pct })
  }
  return out
}

interface MiSubStatus {
  planName?: string
  plan_type?: string
  planType?: string
  productName?: string
  expireTime?: number | string
  endTime?: number | string
  nextPayTime?: number | string
  renewTime?: number | string
  autoRenew?: boolean | number
  price?: number | string
  amount?: number | string
}

function pickPlan(raw: unknown): { name: string; price?: number; renewalDate: string | null; autoRenew?: boolean } | undefined {
  const d = unwrap(raw) as MiSubStatus
  const name = d.planName ?? d.productName ?? d.planType ?? d.plan_type
  if (!name) return undefined
  const renewalDate = toIso(d.nextPayTime ?? d.renewTime ?? d.expireTime ?? d.endTime) ?? null
  const autoRenew = typeof d.autoRenew === 'boolean' ? d.autoRenew : num(d.autoRenew)
  return {
    name: String(name),
    price: num(d.price) ?? num(d.amount),
    renewalDate,
    autoRenew: autoRenew === undefined ? undefined : !!autoRenew,
  }
}

interface MiUsageRow {
  date?: string | number
  consumedAmount?: number | string
  amount?: number | string
  currency?: string
}

function pickUsageDays(raw: unknown): Array<{ date: string; costAmount: number; currency: string }> {
  const d = unwrap(raw)
  const rows = (Array.isArray(d) ? d : (d.list ?? d.records ?? d.details)) as MiUsageRow[] | undefined
  if (!Array.isArray(rows)) return []
  const out: Array<{ date: string; costAmount: number; currency: string }> = []
  for (const r of rows) {
    const date = toDay(r.date)
    const cost = num(r.consumedAmount) ?? num(r.amount)
    if (!date || cost === undefined) continue
    out.push({ date, costAmount: cost, currency: r.currency || 'CNY' })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

function assemble(parts: {
  balance?: { amount: number; currency: string }
  items: MiPlanItem[]
  plan?: ReturnType<typeof pickPlan>
  days: Array<{ date: string; costAmount: number; currency: string }>
  userId?: string
}): PluginFetchResult {
  const notes: string[] = []
  const res: PluginFetchResult = { notes }

  if (parts.balance) res.balance = parts.balance
  else notes.push('未取到余额（/api/v1/balance 无数据）')

  if (parts.items.length) {
    res.windows = parts.items.map((it) => ({
      name: it.name,
      usedPct: Math.min(100, Math.max(0, it.pct)),
      usedValue: it.used,
      limitValue: it.limit,
      unit: 'credits',
      resetAt: parts.plan?.renewalDate ? `${parts.plan.renewalDate}T00:00:00.000Z` : null,
    }))
  } else {
    notes.push('未取到套餐额度（未订阅 Token Plan 或接口结构已变）')
  }

  if (parts.plan) {
    res.plan = {
      name: parts.plan.name,
      price: parts.plan.price,
      currency: 'CNY',
      renewalDate: parts.plan.renewalDate,
      autoRenew: parts.plan.autoRenew,
    }
  }

  if (parts.days.length) {
    // 控制台只给每日消费金额，token 数不在此接口中
    res.usageDaily = parts.days.map((d) => ({ ...d, inputTokens: 0, outputTokens: 0 }))
  } else {
    notes.push('未取到按日消费（/api/v1/usage/detail/list 无数据）')
  }

  res.account = {
    userName: parts.plan?.name ?? 'MiMo 用户',
    maskedContact: parts.userId ? `小米账号 ${parts.userId}` : '',
    region: 'CN',
  }
  return res
}

// ---------- 模式二：常驻页面内调用 ----------

interface PageRequest {
  path: string
  method: string
  body: unknown
}

async function apiInPage<T>(page: import('playwright').Page, req: PageRequest): Promise<{ status: number; data: T | null }> {
  const call = page.evaluate(
    async ([r]) => {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (r.body !== undefined) headers['Content-Type'] = 'application/json'
      // 控制台把 csrf 值同时放在 cookie 与 query 上，缺 query 时部分接口 403
      let url = r.path
      const ph = /api-platform_ph=([^;]+)/.exec(document.cookie)?.[1]
      if (ph) url += (url.includes('?') ? '&' : '?') + 'api-platform_ph=' + encodeURIComponent(ph)

      const res = await fetch(url, {
        method: r.method,
        headers,
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
        credentials: 'include',
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        /* 非 JSON（网关 HTML 页） */
      }
      return { status: res.status, data }
    },
    [req] as [PageRequest]
  ) as Promise<{ status: number; data: T | null }>
  return withTimeout(call, 20_000, { status: 0, data: null })
}

async function collectFromConsole(
  call: <T>(req: PageRequest) => Promise<{ status: number; data: T | null }>
): Promise<{ result: PluginFetchResult; authFailed: boolean }> {
  // 未登录时网关对【任意】/api/v1/* 都返回 401，因此只有全部接口都 401 才判定会话失效；
  // 个别 401 更可能是路径变更，此时仍返回已取到的部分数据。
  const statuses: number[] = []

  const bal = await call<unknown>({ path: EP.balance, method: 'GET', body: undefined })
  statuses.push(bal.status)

  const planUsage = await call<unknown>({ path: EP.planUsage, method: 'GET', body: undefined })
  const subStatus = await call<unknown>({ path: EP.subStatus, method: 'GET', body: undefined })
  const planDetail = await call<unknown>({ path: EP.planDetail, method: 'GET', body: undefined })
  statuses.push(planUsage.status, subStatus.status, planDetail.status)

  const now = new Date()
  const days: Array<{ date: string; costAmount: number; currency: string }> = []
  for (let back = 0; back < 3; back++) {
    const y = new Date(now.getFullYear(), now.getMonth() - back, 1)
    const res = await call<unknown>({
      path: EP.usageList,
      method: 'POST',
      body: { year: y.getFullYear(), month: y.getMonth() + 1 },
    })
    if (back === 0) statuses.push(res.status)
    if (res.status !== 200) break
    for (const d of pickUsageDays(res.data)) {
      if (!days.some((x) => x.date === d.date)) days.push(d)
    }
  }

  const authFailed = statuses.every((s) => s === 401 || s === 403)
  const plan = pickPlan(subStatus.data) ?? pickPlan(planDetail.data)
  const result = assemble({
    balance: pickBalance(bal.data),
    items: pickPlanItems(planUsage.data),
    plan,
    days: days.sort((a, b) => a.date.localeCompare(b.date)),
  })
  result.notes?.push(
    `控制台状态：balance ${bal.status}、planUsage ${planUsage.status}、sub ${subStatus.status}、planDetail ${planDetail.status}、usage ${statuses.at(-1)}`
  )
  return { result, authFailed }
}

const LOGIN_URL = /(passport|account\.xiaomi\.com|\/login|\/signin)/i

async function fetchViaBrowser(ctx: PluginContext): Promise<PluginFetchResult> {
  const fresh = !isPageAlive(ctx.providerId)
  let page = await ensureLivePage(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
  if (fresh) await page.waitForTimeout(2000)

  // 保活页面可能在会话尚未就绪时被弹到 passport 并停在那里；
  // 关掉重建一次（重建会注入 storage-state 快照）再判定，避免把可恢复的会话判成掉登录
  if (LOGIN_URL.test(page.url())) {
    await closeSession(ctx.providerId).catch(() => {})
    page = await ensureLivePage(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
    if (LOGIN_URL.test(page.url())) {
      throw new PluginError('auth_expired', '浏览器会话已过期，请重新登录（详情页 → 更新凭证 → 浏览器登录）')
    }
  }

  const { result, authFailed } = await collectFromConsole(<T>(req: PageRequest) =>
    apiInPage<T>(page, req)
  )
  if (authFailed) {
    throw new PluginError('auth_expired', '控制台接口全部 401：serviceToken 已过期请重新登录，或平台接口路径已变更')
  }
  // 页面里的 token 可能已续期，刷新快照让重启后也能恢复
  await snapshotSession(ctx.providerId, ctx.dataDir).catch(() => {})
  return result
}

// ---------- 模式三：粘贴 Cookie ----------

async function fetchViaPastedCookie(ctx: PluginContext, cookie: string): Promise<PluginFetchResult> {
  const ph = csrfOf(cookie)
  const call = async <T,>(req: PageRequest): Promise<{ status: number; data: T | null }> => {
    const url = CONSOLE_BASE + req.path + (ph ? `${req.path.includes('?') ? '&' : '?'}api-platform_ph=${encodeURIComponent(ph)}` : '')
    try {
      const data = await fetchJson<T>(url, {
        method: req.method as 'GET' | 'POST',
        body: req.body,
        headers: { Cookie: cookie },
      })
      return { status: 200, data }
    } catch (e) {
      const err = e as Error & { status?: number }
      return { status: err.status ?? 0, data: null }
    }
  }

  const { result, authFailed } = await collectFromConsole(call)
  if (authFailed) {
    throw new PluginError('auth_expired', 'Cookie 模式全部接口 401：Cookie 约 24 小时过期，请重新粘贴或改用浏览器登录')
  }
  ctx.log('Cookie 模式采集完成')
  return result
}

function csrfOf(cookie: string): string {
  return /api-platform_ph=([^;]+)/.exec(cookie)?.[1] ?? ''
}

// ---------- 插件入口 ----------

async function importPlaywright(ctx: PluginContext) {
  try {
    return await import('playwright')
  } catch {
    throw new PluginError('not_configured', '未安装 playwright：npm i -D playwright && npx playwright install chromium')
  }
}

export const xiaomimoPlugin: ProviderPlugin = {
  id: 'xiaomimo',
  displayName: 'Xiaomi MiMo',
  icon: '/icons/xiaomimo.ico',
  authMethods: ['apikey', 'browser-login', 'cookie'],
  scheduleDefaultSec: 3600,
  homepage: 'https://platform.xiaomimimo.com',
  consoleUrl: CONSOLE_PAGE,
  cookieGuide: {
    loginUrl: 'https://platform.xiaomimimo.com/',
    steps: [
      '点击下方按钮打开小米大模型开放平台，用小米账号登录（需已完成实名认证）',
      '进入「控制台 / 费用中心」页面，确保能看到余额',
      '按 F12 打开开发者工具，切换到「网络 / Network」标签',
      '刷新页面，点击任意一条 platform.xiaomimimo.com/api/v1 开头的请求',
      '在「请求标头」中找到 Cookie 整条复制，粘贴到下方并「验证并保存」',
      '注意：控制台 Cookie 约 24 小时过期，长期使用请选「浏览器登录」',
    ],
  },

  async login(ctx: PluginContext): Promise<PluginLoginResult> {
    const pw = await importPlaywright(ctx)
    const dir = ensureProfileDir(ctx.dataDir, ctx.providerId)

    // 先释放可能正被无头保活实例占用的 profile：两个 Chromium 同开一个 user-data-dir，
    // 后写入的一方会把对方的 Cookie 冲掉，登录态就是这么丢的
    await closeSession(ctx.providerId).catch(() => {})

    const context = await pw.chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    })

    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(CONSOLE_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      ctx.log('已打开浏览器，等待用户登录…')

      let browserClosed = false
      context.on('close', () => {
        browserClosed = true
      })

      const deadline = Date.now() + 240_000
      let sawCookie = false
      while (Date.now() < deadline) {
        if (browserClosed) return { ok: false, message: '浏览器窗口已关闭，登录已取消' }
        const remain = Math.max(1000, deadline - Date.now())
        await page.waitForTimeout(Math.min(2000, remain)).catch(() => {})

        const cookies = await withTimeout(
          context.cookies(CONSOLE_BASE).catch(() => []),
          10_000,
          [] as Array<{ name: string }>
        )
        if (!cookies.some((c) => c.name === 'api-platform_serviceToken')) continue
        sawCookie = true

        // Cookie 出现后前端仍在补全会话，用页内真实请求实测才算登录完成。
        // 接口路径尚未逐一证实，任一 200 即通过；全部非 200 时退而检查页面是否
        // 停在控制台路由——未登录访问 /#/console 会被 passport 弹回去。
        await page.waitForTimeout(3000).catch(() => {})
        try {
          if (!/#\/console/.test(page.url())) {
            await page.goto(CONSOLE_PAGE, { waitUntil: 'domcontentloaded', timeout: 20_000 })
            await page.waitForTimeout(3000).catch(() => {})
          }
          const probe = await withTimeout(
            Promise.all(
              [EP.balance, EP.planUsage, EP.subStatus].map((path) =>
                apiInPage<unknown>(page, { path, method: 'GET', body: undefined })
              )
            ),
            25_000,
            [] as Array<{ status: number }>
          )
          const verified = probe.some((p) => p.status === 200)
          const onConsole = page.url().includes(CONSOLE_BASE) && /#\/console/.test(page.url())
          if (!verified && !onConsole) {
            ctx.log(`会话尚未生效（状态 ${probe.map((p) => p.status).join('/') || '无响应'}），继续等待…`)
            continue
          }

          markLoggedIn(ctx.dataDir, ctx.providerId)
          // 必须在关闭前导出：passport 发的是 session cookie，关掉就没了
          await persistStorageState(context, ctx.dataDir, ctx.providerId).catch(() => {})
          await context.close().catch(() => {})
          // 丢弃可能存在的旧保活会话（它没有新登录的 Cookie），否则 startKeepAlive 会复用它
          await closeSession(ctx.providerId).catch(() => {})
          await startKeepAlive(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
          return verified
            ? { ok: true, message: '登录成功，会话已保存并启动保活' }
            : {
                ok: true,
                message: '登录会话已保存，但控制台接口未返回 200，采集可能取不到数据（需核对插件接口路径）',
              }
        } catch {
          /* 页面还在跳转，继续等 */
        }
      }
      return {
        ok: false,
        message: sawCookie ? '检测到登录但会话未生效（4 分钟超时），请重试' : '登录超时（4 分钟未检测到登录）',
      }
    } finally {
      await context.close().catch(() => {})
    }
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'apikey') return fetchViaApiKey(ctx, cred.apiKey)
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      // 没登录成功前不要起无头实例：空 profile 会占住目录，把随后登录写入的 Cookie 冲掉
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      return fetchViaBrowser(ctx)
    }
    if (cred.kind === 'cookie') {
      const cookie = normalizeCookie(cred.cookie)
      if (!cookie) throw new PluginError('not_configured', 'Cookie 为空，请先完成获取引导')
      return fetchViaPastedCookie(ctx, cookie)
    }
    throw new PluginError('not_configured', '未配置凭证')
  },
}
