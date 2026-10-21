import { fetchJson } from '~~/server/utils/http'
import { isLoggedIn, markLoggedIn } from '~~/server/utils/browser-profile'
import { closeSession, ensureLivePage, isPageAlive, launchLoginWindow, persistStorageState, snapshotSession, startKeepAlive } from '~~/server/utils/browser-session'
import { PluginError, type PluginContext, type PluginFetchResult, type PluginModelUsage, type PluginUsageDay, type PluginWindow, type ProviderPlugin } from './types'

/**
 * OpenCode 插件（Zen 按量网关 / Go 订阅 / Console Key）
 *
 * 2026-10-21 用真实 Key 实测确认的数据面：
 * · GET /zen/v1/models                          —— Key 探活（无效时 401 Invalid credential）
 * · GET /inference/go/v1/usage                  —— Go 订阅配额 usage.{rolling,weekly,monthly}
 * · GET /console/api/v1/budgets/members         —— 【裸数组】，元素含 user_id/email/limit_micro_cents/
 *                                                  spent_micro_cents/exceeded/resets_at
 * · GET /console/api/usage/cost-by-day?range=   —— 按日 totalCostMicroCents/totalTokens/totalRequests，
 *                                                  range 只接受 7d|30d（90d、365d 返回 400）
 * · GET /console/api/usage/models?range=&page=&pageSize= —— 按模型累计，pageInfo{page,pageSize,total,pageCount}
 * · GET /console/api/usage/summary?range=       —— 窗口内 input/output/cache 拆分合计
 *
 * 拿不到：套餐价格、续费日期、Zen 信用余额。它们走 /console/api/billing/*，
 * 实测对 API Key 返回 403（路由存在但权限不足，只认控制台会话 Cookie）。
 * 金额单位是 microcents = 1e-6 美分 = 1e-8 美元（控制台 bundle 里 sv()=1e8n 做 microcents→dollars，
 * 余额 1500000000 显示 $15.00 佐证），换算一律 /1e8，别按 1e-6 美元算（曾把消费金额放大 100 倍）。
 *
 * 两个曾经踩过的坑：budgets 返回裸数组而不是 {members:[...]}；
 * Go 配额端点并非 Go Key 专属，Console Key 同样可读，不要按前缀跳过。
 */

const GATEWAY = 'https://opencode.ai'
// 控制台是同源 SPA：浏览器登录后带会话 Cookie 才能读 /console/api/billing/*（对 API Key 403）
const CONSOLE_PAGE = `${GATEWAY}/console/`
const EP = {
  models: '/zen/v1/models',
  goUsage: '/inference/go/v1/usage',
  // 会话有效性探测专用：不要求 x-org-id、不要求成员预算权限，200 即登录生效
  user: '/console/api/user',
  orgs: '/console/api/orgs',
  budgets: '/console/api/v1/budgets/members',
  costByDay: '/console/api/usage/cost-by-day',
  usageModels: '/console/api/usage/models',
  // 账单模块（前端 bundle 逆向，prefix /api/billing 挂在 /console 下），仅会话可读
  billingAccount: '/console/api/billing/account',
  billingStatus: '/console/api/billing/status',
  billingDetails: '/console/api/billing/details',
  // Go 订阅状态（/console/{org}/go 页数据源）：续费日/自动续费/套餐标识
  goStatus: '/console/api/go/status',
  // 发票：最近一张 membership 发票即当前套餐价格
  invoices: '/console/api/billing/invoices',
}

// 取数传输层：API Key 模式走 Bearer，浏览器登录模式走页内 fetch（credentials 带会话）
type JsonGet = <T>(path: string) => Promise<T>

// 控制台用量接口只支持这两个 range，取最长的回填历史
const RANGE = '30d'

const WINDOW_LABELS: Record<string, string> = {
  rolling: 'Go 滚动窗口',
  weekly: 'Go 周窗口',
  monthly: 'Go 月窗口',
}

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>
}

interface GoQuota {
  status?: string
  percent?: number | string
  resetsAt?: number | string
}

interface GoUsageResponse {
  usage?: Partial<Record<keyof typeof WINDOW_LABELS, GoQuota>>
}

interface BudgetRow {
  user_id?: string
  email?: string
  limit_micro_cents?: number | string
  spent_micro_cents?: number | string
  exceeded?: boolean
  resets_at?: number | string
}

// 实测该接口直接返回裸数组，不是 {members:[...]}
type BudgetsResponse = BudgetRow[] | { members?: BudgetRow[]; data?: BudgetRow[] }

interface CostDayRow {
  date?: string
  totalCostMicroCents?: number | string
  totalTokens?: number | string
  totalRequests?: number | string
}

interface ModelRow {
  model?: string
  provider?: string
  totalRequests?: number | string
  totalInputTokens?: number | string
  totalOutputTokens?: number | string
  totalCacheReadTokens?: number | string
  totalCacheWrite5mTokens?: number | string
  totalCacheWrite1hTokens?: number | string
  totalCostMicroCents?: number | string
}

interface Paged<T> {
  items?: T[]
  pageInfo?: { page?: number; pageSize?: number; total?: number; pageCount?: number }
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

function toIso(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  const n = num(v)
  if (n === undefined || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

function asRows(res: BudgetsResponse): BudgetRow[] {
  if (Array.isArray(res)) return res
  return res.members ?? res.data ?? []
}

// microcents（1e-6 美分）→ 美元：/1e8（bundle 里 sv()=1e8n，余额 1500000000 → $15.00 实测佐证）
function dollars(microCents: number | undefined): number | undefined {
  return microCents === undefined ? undefined : Number((microCents / 1e8).toFixed(4))
}

// 插件写入的日期一律用 UTC，与 usage_daily 其它来源保持同口径
const utcDay = (back = 0) => new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10)

function maskEmail(email: string): string {
  return email.replace(/^(.).*?(@.*)$/s, '$1***$2')
}

async function getJson<T>(path: string, apiKey: string): Promise<T> {
  return fetchJson<T>(`${GATEWAY}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } })
}

async function fetchGoWindows(get: JsonGet, notes: string[]): Promise<PluginWindow[]> {
  let res: GoUsageResponse
  try {
    res = await get<GoUsageResponse>(EP.goUsage)
  } catch (e) {
    notes.push(`Go 配额接口未取得：${(e as Error).message}`)
    return []
  }
  const windows: PluginWindow[] = []
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const q = res.usage?.[key as keyof typeof WINDOW_LABELS]
    if (!q) continue
    const pct = num(q.percent)
    windows.push({
      name: label,
      usedPct: pct === undefined ? 0 : Math.min(100, Math.max(0, pct)),
      usedValue: null,
      limitValue: null,
      unit: 'pct',
      resetAt: toIso(q.resetsAt),
      extraUsageEnabled: q.status === 'rate-limited',
    })
  }
  if (!windows.length) notes.push('Go 配额接口返回空 usage（该 Key 不是 Go 订阅 Key）')
  return windows
}

/** 逐页拉取按模型累计；pageCount 由服务端给出 */
async function fetchPagedModels(get: JsonGet, notes: string[]): Promise<ModelRow[]> {
  const all: ModelRow[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await get<Paged<ModelRow>>(`${EP.usageModels}?range=${RANGE}&page=${page}&pageSize=100`)
    const items = res.items ?? []
    all.push(...items)
    const pageCount = num(res.pageInfo?.pageCount) ?? 1
    if (page >= pageCount || !items.length) break
  }
  if (!all.length) notes.push('按模型用量接口返回空 items')
  return all
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  const notes: string[] = []
  let models: ModelsResponse
  try {
    models = await getJson<ModelsResponse>(EP.models, apiKey)
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
    }
    throw new PluginError('network', `模型列表请求失败：${err.message}`)
  }
  const list = models.data ?? []
  if (!list.length) throw new PluginError('parse', '模型列表为空，Key 可能没有可用模型权限')

  const isConsoleKey = apiKey.startsWith('oc_sk_')
  const get: JsonGet = <T,>(path: string): Promise<T> => getJson<T>(path, apiKey)
  // Go 配额端点对两类 Key 都开放（实测 Console Key 也能读），所以无条件先取
  const windows = await fetchGoWindows(get, notes)
  const result: PluginFetchResult = {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 6)}••••${apiKey.slice(-4)}`,
      region: 'US',
    },
    plan: {
      name: windows.length ? 'OpenCode Go' : isConsoleKey ? 'OpenCode 按量（Console Key）' : 'OpenCode',
      currency: 'USD',
      // 价格/续费/自动续费在 /console/api/billing/*（对 API Key 403）：明确标未获取到，
      // 不再用 0/false 冒充「免费/按量、未开启」；浏览器登录模式拿到真值后会清除该标记
      unknownFields: ['price', 'renewalDate', 'autoRenew'],
    },
    windows,
    availableModels: list.map((m) => m.id).filter((x): x is string => !!x),
    notes,
  }

  if (isConsoleKey) await collectConsoleData(get, result, notes)
  else notes.push('非 Console Key：读不到预算与消费明细')

  notes.push(`可用模型 ${list.length} 个：${list.slice(0, 8).map((m) => m.id).filter(Boolean).join('、')}${list.length > 8 ? ' …' : ''}`)
  ctx.log(`Key 可用，模型 ${list.length} 个，窗口 ${(result.windows ?? []).length} 个，日用量 ${(result.usageDaily ?? []).length} 天`)
  return result
}

async function collectConsoleData(get: JsonGet, result: PluginFetchResult, notes: string[]) {
  // ---- 预算 / 账户身份 ----
  try {
    const rows = asRows(await get<BudgetsResponse>(EP.budgets))
    if (!rows.length) {
      notes.push('预算接口返回空列表')
    } else {
      const email = rows.find((r) => r.email)?.email
      if (email && result.account) result.account.maskedContact = maskEmail(email)
      const limit = rows.reduce((a, r) => a + (num(r.limit_micro_cents) ?? 0), 0)
      const spent = rows.reduce((a, r) => a + (num(r.spent_micro_cents) ?? 0), 0)
      const resetAt = rows.map((r) => toIso(r.resets_at)).find(Boolean) ?? null
      if (limit > 0) {
        result.windows = [
          ...(result.windows ?? []),
          {
            name: '月度预算',
            usedPct: Math.min(100, Math.round((spent / limit) * 1000) / 10),
            usedValue: dollars(spent),
            limitValue: dollars(limit),
            unit: 'usd',
            resetAt,
            extraUsageEnabled: rows.some((r) => r.exceeded === true),
          },
        ]
      } else {
        notes.push(`未设置月度预算上限（limit=0），已消费 ${dollars(spent) ?? 0} 美元；窗口不展示无意义的 0%`)
      }
      if (rows.length > 1) notes.push(`组织内有 ${rows.length} 条成员预算记录，上面按合计展示`)
    }
  } catch (e) {
    notes.push(`预算接口未取得：${(e as Error).message}`)
  }
  notes.push('套餐价格与续费日期在 /console/api/billing/*（对 API Key 403）：已做浏览器登录的话，同步会自动用会话补采')

  // ---- 按日消费 ----
  try {
    const days = await get<CostDayRow[]>(`${EP.costByDay}?range=${RANGE}`)
    if (Array.isArray(days) && days.length) {
      result.usageDaily = days
        .filter((d) => typeof d.date === 'string')
        .map((d) => ({
          date: String(d.date).slice(0, 10),
          // 按日接口只给 totalTokens 合计，不拆输入/输出；记在 input_tokens 上以保持日总量正确
          inputTokens: num(d.totalTokens) ?? 0,
          outputTokens: 0,
          cachedTokens: 0,
          requests: num(d.totalRequests) ?? 0,
          costAmount: dollars(num(d.totalCostMicroCents)) ?? 0,
          currency: 'USD',
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
      // 日维度接口不带计费平面标记（只有模型维度有 provider），无法拆分订阅/按量：
      // 整体作为未拆分快照声明区间，图表按中性色单柱展示
      result.usageWindow = { from: result.usageDaily?.[0]?.date ?? utcDay(29), to: utcDay() }
      notes.push(`按日消费 ${result.usageDaily.length} 天（接口只给 totalTokens 合计，未拆输入/输出）`)
    } else {
      notes.push('按日消费接口返回空')
    }
  } catch (e) {
    notes.push(`按日消费未取得：${(e as Error).message}`)
  }

  // ---- 按模型累计 ----
  try {
    const rows = await fetchPagedModels(get, notes)
    if (rows.length) {
      const to = utcDay()
      const from = utcDay(29)
      const modelUsage: PluginModelUsage[] = rows
        .filter((r) => r.model)
        .map((r) => ({
          date: to,
          modelId: `${r.provider ? `${r.provider}/` : ''}${r.model}`,
          inputTokens: num(r.totalInputTokens) ?? 0,
          outputTokens: num(r.totalOutputTokens) ?? 0,
          cachedTokens: (num(r.totalCacheReadTokens) ?? 0) + (num(r.totalCacheWrite5mTokens) ?? 0) + (num(r.totalCacheWrite1hTokens) ?? 0),
          requests: num(r.totalRequests) ?? 0,
        }))
      result.modelUsage = modelUsage
      // 这些值是 30 天窗口的累计快照，必须声明区间，否则按模型求和会跨窗口重复累加
      result.modelUsageWindow = { from, to }
      // provider 字段区分计费平面：opencode-go 是 Go 订阅，其余走 Zen 按量网关
      for (const m of modelUsage) m.billing = m.modelId.startsWith('opencode-go/') ? 'subscription' : 'payg'
      notes.push(`模型明细为 ${from} → ${to} 的窗口累计快照（该平台不提供逐日×模型拆分）`)
    }
  } catch (e) {
    notes.push(`按模型用量未取得：${(e as Error).message}`)
  }

  notes.push('Zen 信用余额在 /console/api/billing/* 下（API Key 无权读取）：已做浏览器登录的话会由会话补采')
}

// ---------- 浏览器登录模式：同源会话读控制台（含 API Key 读不到的 billing） ----------

const LOGIN_URL = /(\/login|\/auth|oauth|sign-?in)/i

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

// 页内同源 fetch：带会话 Cookie，无需 Bearer / csrf。
// 控制台所有 /console/api/* 除 /user /orgs 外都要求 x-org-id 头（缺了 400 OrgRequired），
// org id 存在 SPA 的 localStorage["opencode-console.org-id"]，取不到就调 /console/api/orgs 拿第一个
async function fetchInPage<T>(page: import('playwright').Page, path: string): Promise<T> {
  const call = page.evaluate(async (p) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (!/\/console\/api\/(user|orgs)/.test(p)) {
      let org = ''
      try {
        const raw = localStorage.getItem('opencode-console.org-id')
        org = raw ? JSON.parse(raw) : ''
      } catch {
        /* localStorage 不可用 */
      }
      if (!org) {
        try {
          const r = await fetch('/console/api/orgs', { credentials: 'include', headers: { Accept: 'application/json' } })
          const rows = (await r.json()) as Array<{ id?: string }>
          org = rows?.[0]?.id ?? ''
        } catch {
          /* 未登录或网络失败：下面的请求会带着空 org 失败，由调用方判状态码 */
        }
      }
      if (org) headers['x-org-id'] = org
    }
    const res = await fetch(p as string, { credentials: 'include', headers })
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* 非 JSON */
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`) as Error & { status?: number }
      e.status = res.status
      throw e
    }
    return data
  }, path) as Promise<T>
  return Promise.race([
    call,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`请求超时（${path}）`)), 20_000)),
  ])
}

// billing 接口响应结构未经真实会话验证：按语义键名深搜候选字段，
// 采到什么记什么，采不到就保持 unknownFields（红色未获取到），绝不用默认值冒充
function deepFind(obj: unknown, keys: string[], depth = 3): unknown {
  if (!obj || typeof obj !== 'object' || depth < 0) return undefined
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null) return rec[k]
  }
  for (const v of Object.values(rec)) {
    const hit = deepFind(v, keys, depth - 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

function isoOf(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(0, 10)
  return null
}

function num2(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function fmtUsd(v: number, cur?: string): string {
  return (cur === 'CNY' ? '¥' : '$') + v.toFixed(2)
}

async function fetchViaBrowser(ctx: PluginContext): Promise<PluginFetchResult> {
  const fresh = !isPageAlive(ctx.providerId)
  let page = await ensureLivePage(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
  if (fresh) await page.waitForTimeout(2000)

  if (LOGIN_URL.test(page.url())) {
    await closeSession(ctx.providerId).catch(() => {})
    page = await ensureLivePage(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
    if (LOGIN_URL.test(page.url())) {
      throw new PluginError('auth_expired', '浏览器会话已过期，请重新浏览器登录（详情页 → 更新凭证 → 浏览器登录）')
    }
  }

  const get: JsonGet = <T,>(path: string): Promise<T> => fetchInPage<T>(page, path)

  // 会话有效性探测：用 /console/api/user（只要求会话 Cookie；budgets/members 会 403 被误判掉登录）
  try {
    await get(EP.user)
  } catch (e) {
    const s = (e as { status?: number }).status
    if (s === 401 || s === 403) {
      throw new PluginError('auth_expired', `控制台会话已失效（HTTP ${s}），请重新浏览器登录`)
    }
  }

  const notes: string[] = []
  const result: PluginFetchResult = { notes }
  await collectConsoleData(get, result, notes)

  result.plan = {
    name: (result.windows?.length ?? 0) > 0 ? 'OpenCode Go' : 'OpenCode',
    currency: 'USD',
    unknownFields: ['price'],
  }
  await collectBilling(get, result, notes)

  await snapshotSession(ctx.providerId, ctx.dataDir).catch(() => {})
  return result
}

// 会话可用时把 billing 数据合并进已采好的结果（Key 模式与浏览器模式共用）
async function mergeBillingViaSession(ctx: PluginContext, result: PluginFetchResult, notes: string[]) {
  if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
    notes.push('未做浏览器登录：余额/套餐价格/续费日期读不到（详情页 → 更新凭证 → 浏览器登录后自动补采）')
    return
  }
  try {
    const page = await ensureLivePage(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
    if (LOGIN_URL.test(page.url())) {
      notes.push('浏览器会话已过期，本次未补采账单；重新浏览器登录后自动恢复')
      return
    }
    await collectBilling(<T,>(path: string): Promise<T> => fetchInPage<T>(page, path), result, notes)
    await snapshotSession(ctx.providerId, ctx.dataDir).catch(() => {})
  } catch (e) {
    notes.push(`账单补采失败（不影响用量数据）：${(e as Error).message}`)
  }
}

// billing（仅控制台会话可读）：余额 / 续费日 / 自动续费 / 套餐价格。
// 真实数据源（2026-10-21 实测）：
// · /billing/status   → balanceMicroCents/availableMicroCents（/1e8=USD），mode 为 pay-as-you-go（Zen 无订阅字段）
// · /go/status         → access.endsAt=续费日、cancelAtPeriodEnd=false 即自动续订、product='go' 即 Go 套餐
// · /billing/invoices  → 最近一张 paid+membership 发票的 totalMicroCents/1e8 = 当前套餐价格（实测 $10/月）
// 采到什么写什么：字段从未知清单移除；采不到的补进 unknownFields（详情页红色「未获取到」）
async function collectBilling(get: JsonGet, result: PluginFetchResult, notes: string[]) {
  const status: Record<string, number> = {}
  let balance: { amount: number; currency: string } | undefined
  let renewalDate: string | null | undefined
  let autoRenew: boolean | undefined
  let price: number | undefined
  let priceCurrency: string | undefined
  let goProduct: string | undefined

  const probe = async (kind: string, path: string): Promise<unknown> => {
    try {
      const data = await get<unknown>(path)
      status[kind] = 200
      return data
    } catch (e) {
      status[kind] = (e as { status?: number }).status ?? 0
      return undefined
    }
  }

  // ---- 余额 / 模式（account + status + details） ----
  for (const [kind, path] of [
    ['account', EP.billingAccount],
    ['status', EP.billingStatus],
    ['details', EP.billingDetails],
  ] as const) {
    const data = await probe(kind, path)
    if (data === undefined) continue
    // 余额真实字段是 balanceMicroCents/availableMicroCents（字符串），必须 /1e8 转美元；
    // 其余英文键名是结构未知时的兜底，单位按美元直读（真值未见到前不猜）
    const micro = num2(deepFind(data, ['availableMicroCents', 'balanceMicroCents']))
    if (micro !== undefined && !balance) {
      balance = { amount: dollars(micro) ?? 0, currency: String(deepFind(data, ['currency']) ?? 'USD') }
    } else {
      const amount = num2(deepFind(data, ['available_balance', 'availableBalance', 'balance', 'credit_balance', 'credits']))
      if (amount !== undefined && !balance) {
        balance = { amount, currency: String(deepFind(data, ['currency']) ?? 'USD') }
      }
    }
    if (renewalDate === undefined) renewalDate = isoOf(deepFind(data, ['renews_at', 'renewal_date', 'current_period_end', 'next_billing_date', 'period_end']))
    if (autoRenew === undefined) {
      const v = deepFind(data, ['auto_renew', 'autoRenew', 'auto_renew_enabled'])
      if (typeof v === 'boolean') autoRenew = v
      else if (num2(v) !== undefined) autoRenew = !!num2(v)
    }
  }

  // ---- Go 订阅状态：续费日 / 自动续费 / 套餐标识 ----
  const go = (await probe('go', EP.goStatus)) as
    | { product?: string; cancelAtPeriodEnd?: boolean; access?: { endsAt?: string; cancelAtPeriodEnd?: boolean } }
    | undefined
  if (go) {
    goProduct = go.product
    const cancel = go.cancelAtPeriodEnd ?? go.access?.cancelAtPeriodEnd
    if (typeof cancel === 'boolean') autoRenew = !cancel
    if (go.access?.endsAt) renewalDate = isoOf(go.access.endsAt) ?? renewalDate
  }

  // ---- 最近一张已支付 membership 发票 = 当前套餐价格 ----
  const invoices = (await probe('invoices', EP.invoices)) as
    | Array<{ status?: string; purpose?: string; totalMicroCents?: string; currency?: string; periodEnd?: string }>
    | undefined
  if (Array.isArray(invoices)) {
    const latest = invoices
      .filter((r) => r.status === 'paid' && (r.purpose === 'membership' || r.purpose === 'subscription'))
      .sort((a, b) => String(b.periodEnd ?? '').localeCompare(String(a.periodEnd ?? '')))[0]
    const micro = num2(latest?.totalMicroCents)
    if (micro !== undefined) {
      price = dollars(micro)
      priceCurrency = latest?.currency === 'CNY' ? 'CNY' : 'USD'
    }
  }

  notes.push(`账单接口（会话）：${Object.entries(status).map(([k, v]) => `${k} ${v}`).join('、')}`)
  if (balance) result.balance = balance
  else notes.push('账单接口未解析出余额（响应结构待核对）')

  // 计划字段增量更新：采到的从未知清单移除，采不到的补进（红色「未获取到」）
  const plan = result.plan ?? { name: 'OpenCode', currency: 'USD', unknownFields: [] as Array<'price' | 'renewalDate' | 'autoRenew'> }
  const unknowns = new Set(plan.unknownFields ?? [])
  if (goProduct === 'go') plan.name = 'OpenCode Go'
  if (price !== undefined) {
    plan.price = price
    if (priceCurrency) plan.currency = priceCurrency
    unknowns.delete('price')
  } else {
    unknowns.add('price')
  }
  if (renewalDate) {
    plan.renewalDate = renewalDate
    unknowns.delete('renewalDate')
  } else {
    unknowns.add('renewalDate')
  }
  if (autoRenew !== undefined) {
    plan.autoRenew = autoRenew
    unknowns.delete('autoRenew')
  } else {
    unknowns.add('autoRenew')
  }
  plan.unknownFields = [...unknowns]
  result.plan = plan
  const got: string[] = []
  if (price !== undefined) got.push(`价格 ${fmtUsd(price, priceCurrency)}`)
  if (renewalDate) got.push(`续费日 ${renewalDate}`)
  if (autoRenew !== undefined) got.push(`自动续费${autoRenew ? '开' : '关'}`)
  if (got.length) notes.push(`会话采集：${got.join('、')}`)
}

async function importPlaywright(ctx: PluginContext) {
  try {
    return await import('playwright')
  } catch {
    throw new PluginError('not_configured', '未安装 playwright：npm i -D playwright && npx playwright install chromium')
  }
}

export const opencodePlugin: ProviderPlugin = {
  id: 'opencode',
  displayName: 'OpenCode Zen',
  icon: '/icons/opencode.png',
  authMethods: ['apikey', 'browser-login'],
  scheduleDefaultSec: 1800,
  homepage: 'https://opencode.ai/zen',
  consoleUrl: CONSOLE_PAGE,

  async login(ctx: PluginContext): Promise<{ ok: boolean; message: string }> {
    const pw = await importPlaywright(ctx)
    // 避免保活实例与登录实例同开一个 profile 互相冲掉 Cookie（MiMo 踩过的坑）
    await closeSession(ctx.providerId).catch(() => {})

    // 本机 Chrome 打开（未装则回退内置 Chromium）；独立持久 profile，登录一次后快照+保活复用
    const context = await launchLoginWindow(pw, ctx.dataDir, ctx.providerId)
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(CONSOLE_PAGE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      ctx.log('已打开 OpenCode 控制台，等待登录…')

      let closed = false
      context.on('close', () => {
        closed = true
      })
      const deadline = Date.now() + 240_000
      while (Date.now() < deadline) {
        if (closed) return { ok: false, message: '浏览器窗口已关闭，登录已取消' }
        // 关窗后 page 已销毁，waitForTimeout 会抛 TargetClosedError；吞掉并交给下一轮 closed 检查
        await withTimeout(page.waitForTimeout(2500).catch(() => {}), 5000, undefined as void)
        // /console/api/user 只认会话 Cookie，不要求 x-org-id、不要求成员预算权限，
        // 200 即登录生效（旧探测端点 budgets/members 缺 org 头 400、带 org 头此账号 403，永远等不到 200）
        const ok = await page
          .evaluate(async () => {
            try {
              const r = await fetch('/console/api/user', { credentials: 'include', headers: { Accept: 'application/json' } })
              return r.status === 200
            } catch {
              return false
            }
          })
          .catch(() => false)
        if (ok) {
          markLoggedIn(ctx.dataDir, ctx.providerId)
          await persistStorageState(context, ctx.dataDir, ctx.providerId).catch(() => {})
          await context.close().catch(() => {})
          await closeSession(ctx.providerId).catch(() => {})
          await startKeepAlive(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
          return { ok: true, message: '登录成功，会话已保存并启动保活' }
        }
      }
      return { ok: false, message: '登录超时（4 分钟内未检测到会话生效），请重试' }
    } finally {
      await context.close().catch(() => {})
    }
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'apikey') {
      const result = await fetchViaApiKey(ctx, cred.apiKey)
      const notes = result.notes ?? (result.notes = [])
      // billing（余额/续费日/自动续费/价格）对 API Key 403：登录过浏览器会话就补采合并进来
      await mergeBillingViaSession(ctx, result, notes)
      return result
    }
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      // 没登录成功前不要起无头实例：空 profile 会占住目录，把随后登录写入的 Cookie 冲掉
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      // Go 配额/模型/按日用量需要 Bearer（会话 401）：有存 API Key 就走
      // 「Key 采集 + 会话补账单」组合，数据面与 API Key 模式完全一致；无 Key 才纯会话兜底
      const apiCred = ctx.loadCredential?.('apikey')
      if (apiCred?.kind === 'apikey') {
        const result = await fetchViaApiKey(ctx, apiCred.apiKey)
        const notes = result.notes ?? (result.notes = [])
        await mergeBillingViaSession(ctx, result, notes)
        return result
      }
      return fetchViaBrowser(ctx)
    }
    throw new PluginError('not_configured', '凭证类型不支持')
  },
}
