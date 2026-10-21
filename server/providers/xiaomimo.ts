import { fetchJson } from '~~/server/utils/http'
import { normalizeCookie } from '~~/server/utils/cookie'
import { isLoggedIn, markLoggedIn } from '~~/server/utils/browser-profile'
import { closeSession, ensureLivePage, isPageAlive, launchLoginWindow, persistStorageState, snapshotSession, startKeepAlive } from '~~/server/utils/browser-session'
import {
  PluginError,
  type CredentialPayload,
  type PluginContext,
  type PluginFetchResult,
  type PluginLoginResult,
  type PluginModelUsage,
  type PluginUsageDay,
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
 *
 * 2026-10-21 补齐（嗅探 /console/usage 页真实请求实测）：
 * · GET  /api/v1/models               —— 模型列表（OpenRouter 风格，id 带厂商前缀）
 * · GET  /api/v1/userProfile          —— 脱敏手机号/邮箱（页面注释里说的「没有账户端点」已过时）
 * · GET  /api/v1/usage                —— 历史累计 Token/消费 + 账号限流配额
 * · POST /api/v1/usage/detail/list    —— body {year,month}，返回【按天×模型】明细行，
 *                                          字段 date/model/currency/consumedAmount/
 *                                          inputHitToken/inputMissToken/outputToken/requestCount，
 *                                          日期为 UTC，次日 07:00 UTC 校对；月份粒度只能整月拉
 * · POST /api/v1/usage/token-plan/list —— body {year,month}，Token Plan 套餐【按天×模型】用量。
 *    2026-10-21 实测：订阅账号的当期消耗几乎全在这条流上（10 月账单明细 0 行、套餐明细 13 行
 *    含当日 4790 万 tokens），与账单明细是两条独立数据流，必须都收并按日期合并，
 *    否则图表停在几个月前的按量记录、当日用量恒为 0。无消费金额字段（套餐按积分计）。
 * POST 类接口必须带 api-platform_ph 的 query（值在 Cookie 里带引号，取用时要剥掉），
 * 拼装逻辑在 apiInPage / fetchViaPastedCookie 里已统一处理。
 */

const API_BASE = 'https://api.xiaomimimo.com'
const CONSOLE_BASE = 'https://platform.xiaomimimo.com'
const CONSOLE_PAGE = `${CONSOLE_BASE}/#/console/balance`

const EP = {
  balance: '/api/v1/balance',
  planUsage: '/api/v1/tokenPlan/usage',
  planDetail: '/api/v1/tokenPlan/detail',
  planList: '/api/v1/tokenPlan/list',
  models: '/api/v1/models',
  userProfile: '/api/v1/userProfile',
  usage: '/api/v1/usage',
  usageDetail: '/api/v1/usage/detail/list',
  usageTokenPlan: '/api/v1/usage/token-plan/list',
}

// 用量明细按月整取，回填近 N 个月（含当月）
const DETAIL_MONTHS = 6

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
    availableModels: list.map((m) => m.id).filter((x): x is string => !!x),
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

// tokenPlan/detail 不含价格，目录价在 tokenPlan/list 里按 planCode 匹配
function pickPriceForPlan(raw: unknown, planCode?: string): { price: number; currency: string } | undefined {
  if (!planCode) return undefined
  const d = unwrap(raw)
  const rows = (Array.isArray(d) ? d : (d.list ?? d.records)) as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(rows)) return undefined
  const hit = rows.find((r) => String(r.planCode ?? '') === planCode)
  if (!hit) return undefined
  const price = num(hit.planPrice) ?? num(hit.discountPrice) ?? num(hit.originalPrice)
  if (price === undefined) return undefined
  return { price, currency: String(hit.currency ?? 'CNY') }
}

interface MiPlanItem {
  name: string
  used: number
  limit: number
  pct: number
}

// tokenPlan/usage 实测（2026-10-20）同时返回两组：
// data.usage.items = [plan_total_token, compensation_total_token]，data.monthUsage.items = [month_total_token]
function pickPlanItems(raw: unknown): MiPlanItem[] {
  const d = unwrap(raw)
  const LABELS: Record<string, string> = {
    plan_total_token: '套餐 Credits',
    compensation_total_token: '补偿 Credits',
    month_total_token: '本月 Credits',
  }
  const groups = [d.usage, d.monthUsage].filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')

  const out: MiPlanItem[] = []
  const seen = new Set<string>()
  for (const g of groups) {
    const items = g.items ?? g.plans
    const rows: Array<Record<string, unknown>> = Array.isArray(items)
      ? (items as Array<Record<string, unknown>>)
      : items && typeof items === 'object'
        ? Object.entries(items as Record<string, unknown>).map(([k, v]) => ({ name: k, ...((v ?? {}) as Record<string, unknown>) }))
        : []
    for (const it of rows) {
      const key = String(it.name ?? '')
      const used = num(it.used) ?? num(it.usedValue) ?? num(it.total)
      const limit = num(it.limit) ?? num(it.limitValue) ?? num(it.totalQuota)
      if (!key || used === undefined || limit === undefined || seen.has(key)) continue
      seen.add(key)
      const pct = limit > 0 ? (used / limit) * 100 : (num(it.percent) ?? num(it.usagePercent) ?? 0) * 100
      out.push({ name: LABELS[key] ?? key, used, limit, pct })
    }
  }
  return out
}

interface MiSubStatus {
  planCode?: string
  planName?: string
  plan_type?: string
  planType?: string
  productName?: string
  // tokenPlan/detail 实测字段（2026-10-20）：currentPeriodEnd 是「2026-10-24 23:59:59」裸串
  currentPeriodEnd?: number | string
  expireTime?: number | string
  endTime?: number | string
  nextPayTime?: number | string
  renewTime?: number | string
  enableAutoRenew?: boolean | number
  autoRenew?: boolean | number
  price?: number | string
  amount?: number | string
}

function pickPlan(raw: unknown): { name: string; planCode?: string; price?: number; renewalDate: string | null; autoRenew?: boolean } | undefined {
  const d = unwrap(raw) as MiSubStatus
  const name = d.planName ?? d.productName ?? d.planType ?? d.plan_type
  if (!name) return undefined
  const renewalDate = toIso(d.currentPeriodEnd ?? d.nextPayTime ?? d.renewTime ?? d.expireTime ?? d.endTime) ?? null
  const auto = d.enableAutoRenew ?? d.autoRenew
  const autoRenew = typeof auto === 'boolean' ? auto : num(auto)
  return {
    name: String(name),
    planCode: d.planCode,
    price: num(d.price) ?? num(d.amount),
    renewalDate,
    autoRenew: autoRenew === undefined ? undefined : !!autoRenew,
  }
}

interface MiUsageTotals {
  totalToken: number
  totalCost: string
  currentMonthCost: string
  tpm: number
  rpm: number
  concurrency: number
}

// GET /api/v1/usage：历史累计口径（当前月份单独给 currentMonthCost）
function pickUsageTotals(raw: unknown): MiUsageTotals | undefined {
  const d = unwrap(raw) as {
    tokenUsage?: { totalToken?: number | string }
    costUsage?: { totalCost?: string; currentMonthCost?: string }
    accountRateLimit?: { tpm?: number | string; rpm?: number | string; concurrency?: number | string }
  }
  const total = num(d.tokenUsage?.totalToken)
  if (total === undefined && !d.costUsage) return undefined
  return {
    totalToken: total ?? 0,
    totalCost: String(d.costUsage?.totalCost ?? '0'),
    currentMonthCost: String(d.costUsage?.currentMonthCost ?? '0'),
    tpm: num(d.accountRateLimit?.tpm) ?? 0,
    rpm: num(d.accountRateLimit?.rpm) ?? 0,
    concurrency: num(d.accountRateLimit?.concurrency) ?? 0,
  }
}

interface MiUsageRow {
  date?: string
  model?: string
  currency?: string
  consumedAmount?: number | string
  inputHitToken?: number | string
  inputMissToken?: number | string
  outputToken?: number | string
  requestCount?: number | string
}

function recentMonths(n: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = []
  const now = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  return out
}

interface MiPlanUsageRow {
  date?: string
  model?: string
  totalToken?: number | string
  inputHitToken?: number | string
  inputMissToken?: number | string
  outputToken?: number | string
  requestCount?: number | string
}

// 账单明细（按量，含 CNY 消费）与 Token Plan 套餐用量（无消费金额）是两条独立数据流：
// 日维度按计费平面分行——usage_daily 主键含 plan_name，订阅行挂主计划、按量行挂
// 「按量付费」，才能同日并存不互相覆盖；usage_model_daily 主键无计划列，
// 同日同模型两流先合并再落库，混合行不标平面。
function aggregateUsage(
  billed: MiUsageRow[],
  planned: MiPlanUsageRow[],
  planName: string
): {
  usage: PluginUsageDay[]
  models: PluginModelUsage[]
  window: { from: string; to: string }
  rows: number
  billedRows: number
  planRows: number
} | null {
  const b = billed.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? '')))
  const p = planned.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? '')))
  if (!b.length && !p.length) return null

  const dayMap = new Map<string, { date: string; billing: 'subscription' | 'payg'; hit: number; miss: number; out: number; req: number; cost: number; currency: string }>()
  const modelMap = new Map<string, PluginModelUsage>()
  const add = (
    date: string,
    model: string | undefined,
    hit: number,
    miss: number,
    out: number,
    req: number,
    cost: number,
    currency: string,
    billing: 'subscription' | 'payg'
  ) => {
    const dkey = `${date}|${billing}`
    const day = dayMap.get(dkey) ?? { date, billing, hit: 0, miss: 0, out: 0, req: 0, cost: 0, currency }
    day.hit += hit
    day.miss += miss
    day.out += out
    day.req += req
    day.cost += cost
    dayMap.set(dkey, day)
    if (model) {
      const key = `${date}|${model}`
      const m = modelMap.get(key) ?? { date, modelId: model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, billing }
      m.inputTokens = (m.inputTokens ?? 0) + miss
      m.cachedTokens = (m.cachedTokens ?? 0) + hit
      m.outputTokens = (m.outputTokens ?? 0) + out
      m.requests = (m.requests ?? 0) + req
      if (m.billing !== billing) m.billing = undefined
      modelMap.set(key, m)
    }
  }
  for (const r of b) {
    add(
      String(r.date),
      r.model,
      num(r.inputHitToken) ?? 0,
      num(r.inputMissToken) ?? 0,
      num(r.outputToken) ?? 0,
      num(r.requestCount) ?? 0,
      num(r.consumedAmount) ?? 0,
      r.currency || 'CNY',
      'payg'
    )
  }
  for (const r of p) {
    add(String(r.date), r.model, num(r.inputHitToken) ?? 0, num(r.inputMissToken) ?? 0, num(r.outputToken) ?? 0, num(r.requestCount) ?? 0, 0, 'CNY', 'subscription')
  }

  const dates = [...new Set([...dayMap.values()].map((d) => d.date))].sort()
  const today = new Date().toISOString().slice(0, 10)
  return {
    usage: [...dayMap.values()]
      .sort((a, b2) => a.date.localeCompare(b2.date) || a.billing.localeCompare(b2.billing))
      .map((d) => ({
        date: d.date,
        inputTokens: d.miss,
        cachedTokens: d.hit,
        outputTokens: d.out,
        requests: d.req,
        costAmount: Number(d.cost.toFixed(6)),
        currency: d.currency,
        planName: d.billing === 'subscription' ? planName : '按量付费',
        billing: d.billing,
      })),
    models: [...modelMap.values()],
    // 区间取「最早明细月的 1 号 → 今天」，同步时整体替换该区间旧行
    window: { from: `${dates[0].slice(0, 7)}-01`, to: today },
    rows: b.length + p.length,
    billedRows: b.length,
    planRows: p.length,
  }
}

function assemble(parts: {
  balance?: { amount: number; currency: string }
  items: MiPlanItem[]
  plan?: ReturnType<typeof pickPlan>
  userId?: string
  contact?: string
  userName?: string
  availableModels?: string[]
  usageTotals?: MiUsageTotals
  daily?: {
    usage: PluginUsageDay[]
    models: PluginModelUsage[]
    window: { from: string; to: string }
    rows: number
    billedRows: number
    planRows: number
  }
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

  if (parts.availableModels) {
    res.availableModels = parts.availableModels
    notes.push(`可用模型 ${parts.availableModels.length} 个（控制台 /api/v1/models）`)
  }

  if (parts.usageTotals) {
    const t = parts.usageTotals
    notes.push(
      `平台历史累计：Token ${t.totalToken.toLocaleString('en-US')}，消费 ${t.totalCost} CNY，当月消费 ${t.currentMonthCost} CNY`
    )
    notes.push(`账号限流：TPM ${t.tpm.toLocaleString('en-US')} / RPM ${t.rpm} / 并发 ${t.concurrency}`)
  }

  if (parts.daily?.usage.length) {
    res.usageDaily = parts.daily.usage
    res.modelUsage = parts.daily.models
    // 明细是整月拉取的区间快照：必须声明区间，否则每次同步按模型求和/改挂计划名后会重复累加
    res.modelUsageWindow = parts.daily.window
    res.usageWindow = parts.daily.window
    notes.push(
      `用量明细已回填 ${parts.daily.rows} 行（账单 ${parts.daily.billedRows} + Token Plan ${parts.daily.planRows}，近 ${DETAIL_MONTHS} 个月，UTC 口径，当日数据次日 07:00 UTC 校对）`
    )
  } else if (parts.daily) {
    notes.push(`用量明细为空（近 ${DETAIL_MONTHS} 个月无调用记录）`)
  }

  res.account = {
    userName: parts.userName || 'MiMo 用户',
    maskedContact: parts.contact ?? (parts.userId ? `小米账号 ${parts.userId}` : ''),
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
      // 控制台把 csrf 值同时放在 cookie 与 query 上，缺 query 时部分接口 403。
      // Cookie 里的值带一对双引号（"xxxx"），直接拼进 query 会被判非法 ph → 401，必须剥掉
      let url = r.path
      const ph = /api-platform_ph=([^;]+)/.exec(document.cookie)?.[1]?.replace(/^"|"$/g, '')
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
  // 控制台 SPA 对任意 401/403 都执行全局登出并清空 Cookie，一次失手整个会话即报废。
  // 所以逐个探测、一见 401/403 就停止后续请求，让调用方抛错且不把受损会话落盘。
  let authFailed = false
  const probe = async <T>(req: PageRequest): Promise<{ status: number; data: T | null }> => {
    if (authFailed) return { status: 0, data: null }
    const res = await call<T>(req)
    if (res.status === 401 || res.status === 403) authFailed = true
    return res
  }

  const bal = await probe<unknown>({ path: EP.balance, method: 'GET', body: undefined })
  const planUsage = await probe<unknown>({ path: EP.planUsage, method: 'GET', body: undefined })
  const planDetail = await probe<unknown>({ path: EP.planDetail, method: 'GET', body: undefined })
  const planList = await probe<unknown>({ path: EP.planList, method: 'GET', body: undefined })
  const models = await probe<{ data?: Array<{ id?: string }> }>({ path: EP.models, method: 'GET', body: undefined })
  const profile = await probe<{ data?: { userId?: string; phone?: string; email?: string; nickName?: string; userName?: string } }>({
    path: EP.userProfile,
    method: 'GET',
    body: undefined,
  })
  const usage = await probe<unknown>({ path: EP.usage, method: 'GET', body: undefined })

  // 两条用量流按月整取（账单明细 + Token Plan 套餐）；任一月份/任一流失败则整批丢弃
  // （宁可保留旧数据，不落半套）
  const months = recentMonths(DETAIL_MONTHS)
  const billed: MiUsageRow[] = []
  const planned: MiPlanUsageRow[] = []
  let billedOk = 0
  let planOk = 0
  for (const { year, month } of months) {
    const a = await probe<{ data?: MiUsageRow[] }>({ path: EP.usageDetail, method: 'POST', body: { year, month } })
    if (a.status === 200 && Array.isArray(a.data?.data)) {
      billedOk++
      billed.push(...a.data.data)
    }
    if (authFailed) break
    const b = await probe<{ data?: MiPlanUsageRow[] }>({ path: EP.usageTokenPlan, method: 'POST', body: { year, month } })
    if (b.status === 200 && Array.isArray(b.data?.data)) {
      planOk++
      planned.push(...b.data.data)
    }
    if (authFailed) break
  }

  const plan = pickPlan(planDetail.data)
  const priced = plan ? { ...plan, price: pickPriceForPlan(planList.data, plan.planCode)?.price ?? plan.price } : undefined
  const pf = profile.data?.data
  const result = assemble({
    balance: pickBalance(bal.data),
    items: pickPlanItems(planUsage.data),
    plan: priced,
    userId: pf?.userId,
    contact: pf?.phone || pf?.email || undefined,
    userName: pf?.userName || pf?.nickName || undefined,
    // 控制台模型 id 带厂商前缀（xiaomi/…），用量明细与价目表用的是裸名，去掉前缀对齐并去重
    availableModels:
      models.status === 200
        ? [
            ...new Set(
              (models.data?.data ?? [])
                .map((m) => (m.id ?? '').split('/').pop() ?? '')
                .filter((x): x is string => !!x)
            ),
          ]
        : undefined,
    usageTotals: usage.status === 200 ? pickUsageTotals(usage.data) : undefined,
    daily:
      billedOk === months.length && planOk === months.length
        ? aggregateUsage(billed, planned, plan?.name ?? 'Standard') ?? { usage: [], models: [], window: { from: '', to: '' }, rows: 0, billedRows: 0, planRows: 0 }
        : undefined,
  })
  result.notes?.push(
    `控制台状态：balance ${bal.status}、planUsage ${planUsage.status}、planDetail ${planDetail.status}、planList ${planList.status}、models ${models.status}、userProfile ${profile.status}、usage ${usage.status}、usageDetail 账单 ${billedOk}/${DETAIL_MONTHS} 月 + 套餐 ${planOk}/${DETAIL_MONTHS} 月` +
      (authFailed ? '；已中断后续请求（SPA 全局登出会清空 Cookie）' : '')
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
    throw new PluginError('auth_expired', '控制台接口返回 401/403：SPA 全局登出已清空会话 Cookie，请重新浏览器登录（详情页 → 更新凭证 → 浏览器登录）')
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
    throw new PluginError('auth_expired', 'Cookie 模式接口 401/403：Cookie 约 24 小时过期，请重新粘贴或改用浏览器登录')
  }
  ctx.log('Cookie 模式采集完成')
  return result
}

function csrfOf(cookie: string): string {
  // Cookie 原文里的 ph 值带双引号，剥掉后再进 query
  return /api-platform_ph=([^;]+)/.exec(cookie)?.[1]?.replace(/^"|"$/g, '') ?? ''
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

    // 先释放可能正被无头保活实例占用的 profile：两个 Chromium 同开一个 user-data-dir，
    // 后写入的一方会把对方的 Cookie 冲掉，登录态就是这么丢的
    await closeSession(ctx.providerId).catch(() => {})

    // 本机 Chrome 打开（未装则回退内置 Chromium）；独立持久 profile，登录一次后快照+保活复用
    const context = await launchLoginWindow(pw, ctx.dataDir, ctx.providerId)

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
              [EP.balance, EP.planUsage, EP.planDetail].map((path) =>
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
