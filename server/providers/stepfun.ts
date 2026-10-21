import { fetchJson } from '~~/server/utils/http'
import { normalizeCookie } from '~~/server/utils/cookie'
import { isLoggedIn, jwtExpMs, markLoggedIn } from '~~/server/utils/browser-profile'
import { closeSession, ensureLivePage, isPageAlive, launchLoginWindow, persistStorageState, snapshotSession, startKeepAlive } from '~~/server/utils/browser-session'
import { PluginError, type CredentialPayload, type PluginContext, type PluginFetchResult, type PluginLoginResult, type ProviderPlugin } from './types'

/**
 * StepFun（阶跃星辰）插件
 *
 * 取数策略：
 * 1. apikey —— 官方文档接口 GET https://api.stepfun.com/v1/accounts（余额/账户类型）
 * 2. browser-login —— Playwright 持久化 profile：用户首次在真实浏览器登录一次，
 *    之后每次同步用同一 profile 启动（headless），前端自动刷新短效 JWT，
 *    RPC 调用在页面上下文内执行，自动携带全部鉴权头。
 * 3. cookie —— 直连控制台 Connect-RPC（粘贴的 Cookie）。注意 Oasis-Token 只有
 *    30 分钟寿命且刷新后旧 token 立即作废，仅适合临时使用。
 *
 * 控制台 RPC 端点从前端 bundle 的 protobuf 描述逆向获得（无官方文档）。
 */

const API_BASE = 'https://api.stepfun.com'
const CONSOLE_BASE = 'https://platform.stepfun.com'
const RPC_PATH = '/api/step.openapi.devcenter.Dashboard'

interface StepFunAccount {
  object?: string
  type?: 'prepaid' | 'postpaid' | string
  balance?: number
  total_cash_balance?: number
  total_voucher_balance?: number
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

// 给可能挂起的异步操作加硬超时（页面无响应时防止整个流程卡死）
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

async function fetchAccountViaApi(apiKey: string, base: string): Promise<StepFunAccount> {
  return fetchJson<StepFunAccount>(`${base}/v1/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
}

// 模型列表只在 API Key 模式下可取；返回 undefined 时执行器保留库里上一次的列表
async function fetchModelsViaApi(apiKey: string, base: string): Promise<string[] | undefined> {
  try {
    const res = await fetchJson<{ data?: Array<{ id?: string }> }>(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const ids = (res.data ?? []).map((m) => m.id).filter((x): x is string => !!x)
    return ids.length ? ids : undefined
  } catch {
    return undefined
  }
}

// ---------- 页面内 RPC（复用前端自身的鉴权机制） ----------

interface PlanStatusResponse {
  status?: number | string
  desc?: string
  subscription?: {
    plan_type?: number | string
    name?: string
    status?: number | string
    activated_at?: number | string
    expired_at?: number | string
    auto_renew?: boolean
    plan_id?: string
  }
  plan_definition?: {
    type?: number | string
    price?: number | string
    duration_days?: number | string
    plan_id?: string
  }
  billing_mode?: number | string
}

interface UsageRecord {
  modelId?: string
  fromTime?: number | string
  toTime?: number | string
  amount?: number | string
  inAmount?: number | string
  outAmount?: number | string
  cacheAmount?: number | string
  cost?: number | string
  totalCost?: number | string
  voucherCost?: number | string
}

interface UsageHistoryResponse {
  status?: number | string
  desc?: string
  total?: number | string
  availTokens?: number | string
  records?: UsageRecord[]
}

interface BalanceResponse {
  voucher?: number | string
  payment?: number | string
}

// Step Plan 套餐用量记录（QueryStepPlanUsages）
interface StepPlanUsageRecord {
  from_time?: number | string
  to_time?: number | string
  model_id?: string
  calls?: number | string
  credit_consumed?: number | string
  in_amount?: number | string
  out_amount?: number | string
  cache_amount?: number | string
}

interface StepPlanUsagesResponse {
  status?: number | string
  desc?: string
  total?: number | string
  records?: StepPlanUsageRecord[]
}

interface UserInfoResponse {
  uid?: string
  mobile?: string
  email?: string
  activated?: boolean
}

// 额度与重置时间（QueryStepPlanRateLimit）——时间单位注意：Usages 系列接口为毫秒
interface CreditBucket {
  type?: number
  credit_total?: number | string
  credit_residual?: number | string
  expire_at?: number | string
  next_reset_at?: number | string
}

interface RateLimitResponse {
  status?: number | string
  desc?: string
  five_hour_usage_left_rate?: number
  five_hour_usage_reset_time?: number | string
  weekly_usage_left_rate?: number
  weekly_usage_reset_time?: number | string
  plan_credit_rate_limit?: {
    subscription_credit_left_rate?: number
    subscription_credit_reset_time?: number | string
    topup_credit_left_rate?: number
    credit_buckets?: CreditBucket[]
  }
}

// 合并 Step Plan 用量记录与按量计费记录，统一成采集快照
function buildSnapshot(
  planStatus: PlanStatusResponse | null,
  planRecords: StepPlanUsageRecord[],
  openapiRecords: UsageRecord[],
  availTokens: number | undefined,
  balance: { amount: number; currency: string } | undefined,
  userInfo: UserInfoResponse | null,
  rateLimit: RateLimitResponse | null,
  nowSec: number,
  notes: string[]
): PluginFetchResult {
  const sub = planStatus?.subscription
  const def = planStatus?.plan_definition

  const planName = sub?.name || (def?.type !== undefined ? `Step Plan (type ${def.type})` : 'Step Plan')
  const expiredAt = num(sub?.expired_at)
  const activatedAt = num(sub?.activated_at)

  // 套餐周期内的 Credits 消耗（QueryStepPlanUsages 记录为毫秒时间戳）
  const periodStartMs = (activatedAt && expiredAt && expiredAt > nowSec ? activatedAt : nowSec - 30 * 86400) * 1000
  const periodPlan = planRecords.filter((r) => (num(r.from_time) ?? 0) >= periodStartMs)
  const usedCredits = periodPlan.reduce((a, r) => a + (num(r.credit_consumed) ?? 0), 0)

  // 额度窗口：credit_buckets 是权威来源（total/residual/next_reset），按 bucket.type 分别建窗口。
  // 之前只取第一个 total>0 的桶并统一叫「套餐周期 Credits」，会把充值池当成订阅池展示。
  const BUCKET_LABELS: Record<number, string> = { 1: '订阅 Credits', 2: '充值 Credits' }
  const windows: NonNullable<PluginFetchResult['windows']> = []
  const planRate = rateLimit?.plan_credit_rate_limit
  const buckets = planRate?.credit_buckets ?? []
  for (const b of buckets) {
    const total = num(b.credit_total) ?? 0
    if (total <= 0) continue
    const residual = num(b.credit_residual) ?? 0
    const nextReset = num(b.next_reset_at)
    const expire = num(b.expire_at)
    const resetSec = nextReset && nextReset > 0 ? nextReset : expire
    windows.push({
      name: BUCKET_LABELS[num(b.type) ?? 0] ?? `额度桶 ${b.type ?? '?'}`,
      usedPct: Math.min(100, Math.max(0, Math.round(((total - residual) / total) * 1000) / 10)),
      usedValue: total - residual,
      limitValue: total,
      unit: 'credits',
      resetAt: resetSec ? new Date(resetSec * 1000).toISOString() : null,
    })
  }
  if (!windows.length && usedCredits > 0) {
    // 兜底：无 bucket 信息时按用量展示
    windows.push({
      name: '订阅 Credits',
      usedPct: 0,
      usedValue: usedCredits,
      limitValue: null,
      unit: 'credits',
      resetAt: expiredAt ? new Date(expiredAt * 1000).toISOString() : null,
    })
  }

  // 5 小时 / 周窗口（部分套餐族提供）。left_rate 为 0 且无 reset 时间表示该套餐族不适用，
  // 不能当成「已用满 100%」
  const rl5h = num(rateLimit?.five_hour_usage_left_rate)
  const rlWeek = num(rateLimit?.weekly_usage_left_rate)
  if (rl5h !== undefined && (rl5h > 0 || num(rateLimit?.five_hour_usage_reset_time))) {
    windows.push({
      name: '5小时窗口',
      usedPct: Math.max(0, Math.min(100, 100 - rl5h)),
      usedValue: null,
      limitValue: null,
      unit: 'pct',
      resetAt: rateLimit?.five_hour_usage_reset_time
        ? new Date((num(rateLimit.five_hour_usage_reset_time) ?? 0) * 1000).toISOString()
        : null,
    })
  }
  if (rlWeek !== undefined && (rlWeek > 0 || num(rateLimit?.weekly_usage_reset_time))) {
    windows.push({
      name: '周窗口',
      usedPct: Math.max(0, Math.min(100, 100 - rlWeek)),
      usedValue: null,
      limitValue: null,
      unit: 'pct',
      resetAt: rateLimit?.weekly_usage_reset_time
        ? new Date((num(rateLimit.weekly_usage_reset_time) ?? 0) * 1000).toISOString()
        : null,
    })
  }

  // 订阅（Step Plan Credits）与按量（OpenAPI 计费）是两条独立数据流：
  // 日维度按 billing 分行（usage_daily 主键含 plan_name，按量行挂独立计划名才能与订阅行并存）；
  // 模型维度主键无计划列，同日同模型两流合并，混合行不标平面
  type Billing = 'subscription' | 'payg'
  const byDay = new Map<string, { date: string; billing: Billing; input: number; output: number; cached: number; requests: number; cost: number }>()
  const byModelDay = new Map<string, { date: string; modelId: string; input: number; output: number; cached: number; requests: number; billing?: Billing }>()

  const add = (day: string, modelId: string, input: number, output: number, cached: number, calls: number, cost: number, billing: Billing) => {
    const dkey = `${day}|${billing}`
    const d = byDay.get(dkey) ?? { date: day, billing, input: 0, output: 0, cached: 0, requests: 0, cost: 0 }
    d.input += input
    d.output += output
    d.cached += cached
    d.requests += calls
    d.cost += cost
    byDay.set(dkey, d)

    const key = `${day}|${modelId}`
    const m = byModelDay.get(key) ?? { date: day, modelId, input: 0, output: 0, cached: 0, requests: 0, billing }
    m.input += input
    m.output += output
    m.cached += cached
    m.requests += calls
    if (m.billing !== billing) m.billing = undefined
    byModelDay.set(key, m)
  }

  for (const r of planRecords) {
    const t = num(r.from_time)
    if (t === undefined) continue
    // credit_consumed 是套餐 Credits 而非金额，费用记 0（订阅已覆盖），Credits 余量体现在额度窗口
    add(
      tsToDate(Math.floor(t / 1000)), // QueryStepPlanUsages 时间为毫秒
      r.model_id || 'unknown',
      num(r.in_amount) ?? 0,
      num(r.out_amount) ?? 0,
      num(r.cache_amount) ?? 0,
      num(r.calls) ?? 0,
      0,
      'subscription'
    )
  }
  for (const r of openapiRecords) {
    const t = num(r.fromTime)
    if (t === undefined) continue
    add(
      tsToDate(t),
      r.modelId || 'unknown',
      num(r.inAmount) ?? 0,
      num(r.outAmount) ?? 0,
      num(r.cacheAmount) ?? 0,
      1,
      (num(r.totalCost) ?? num(r.cost) ?? 0) / 100,
      'payg'
    )
  }

  const usageDaily = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.billing.localeCompare(b.billing))
    .map((v) => ({
      date: v.date,
      inputTokens: v.input,
      outputTokens: v.output,
      cachedTokens: v.cached,
      requests: v.requests,
      costAmount: Number(v.cost.toFixed(4)),
      currency: 'CNY',
      planName: v.billing === 'subscription' ? planName : '按量付费',
      billing: v.billing,
    }))

  // 按「日 + 模型」输出真实单日明细：此前按模型累计后再盖上最后一个日期，
  // 会让模型明细比同日总用量大数倍
  const modelUsage = [...byModelDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || b.input + b.output - (a.input + a.output))
    .map((v) => ({
      date: v.date,
      modelId: v.modelId,
      inputTokens: v.input,
      outputTokens: v.output,
      cachedTokens: v.cached,
      requests: v.requests,
      billing: v.billing,
    }))

  // 窗口报告「未消耗」但查询区间内有真实 token 时，两个口径矛盾，明确写进 notes，
  // 不再静默展示一个 0% 的指标让人误读成额度充足
  const periodTokens = usageDaily.reduce((a, u) => a + u.inputTokens + u.outputTokens + u.cachedTokens, 0)
  const idleCreditWindow = windows.find((w) => w.unit === 'credits' && (w.usedValue ?? 0) === 0 && (w.limitValue ?? 0) > 0)
  if (idleCreditWindow && periodTokens > 0) {
    notes.push(
      `口径冲突：${idleCreditWindow.name} 报告已用 0/${idleCreditWindow.limitValue}（订阅剩余率 ${planRate?.subscription_credit_left_rate ?? '未知'}），` +
        `但查询区间内有 ${periodTokens} tokens 用量，请以控制台页面为准`
    )
  }

  const maskedMobile = userInfo?.mobile ? userInfo.mobile.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : undefined

  return {
    account:
      userInfo?.uid || maskedMobile
        ? {
            userName: maskedMobile || 'StepFun 用户',
            maskedContact: `uid ${userInfo?.uid ?? ''}`,
            region: 'CN',
          }
        : undefined,
    plan: {
      name: planName,
      price: def?.price !== undefined ? (num(def.price) ?? 0) / 100 : undefined,
      currency: 'CNY',
      renewalDate: expiredAt ? tsToDate(expiredAt) : null,
      autoRenew: !!sub?.auto_renew,
    },
    balance,
    windows,
    usageDaily,
    // 采集区间为近 90 天（fetch 侧 fromSec）：整体快照替换，防止改挂计划名后旧行残留双倍计数
    usageWindow: { from: tsToDate(nowSec - 90 * 86400), to: tsToDate(nowSec) },
    modelUsage,
    notes: [
      ...notes,
      sub ? `订阅 ${planName}` : '未查询到 Step Plan 订阅',
      `套餐记录 ${planRecords.length} / 按量 ${openapiRecords.length}`,
      availTokens !== undefined ? `剩余 Credits ${availTokens}` : '',
    ].filter(Boolean),
  }
}

// 在 Playwright 页面上下文里执行 RPC（same-origin + 前端同款客户端标识头）
// 关键：缺 oasis-appid / oasis-platform / connect-protocol-version 头时，
// 服务端会把合法 token 判为 "oasis-token is embezzled"（盗用）并返回 401
async function rpcInPage<T>(page: import('playwright').Page, method: string, body: unknown): Promise<{ status: number; data: T | null }> {
  const call = page.evaluate(
    async ([path, bodyStr]) => {
      const res = await fetch(path as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'connect-protocol-version': '1',
          'oasis-appid': '10300',
          'oasis-platform': 'web',
        },
        body: bodyStr as string,
        credentials: 'include',
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        /* non-JSON */
      }
      return { status: res.status, data }
    },
    [`${RPC_PATH}/${method}`, JSON.stringify(body)] as [string, string]
  ) as Promise<{ status: number; data: T | null }>
  return withTimeout(call, 20_000, { status: 0, data: null })
}

function tsToDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

// ---------- 模式：持久浏览器（推荐） ----------

async function importPlaywright(ctx: PluginContext) {
  try {
    return await import('playwright')
  } catch {
    throw new PluginError('not_configured', '未安装 playwright：npm i -D playwright && npx playwright install chromium')
  }
}

async function fetchViaBrowser(ctx: PluginContext): Promise<PluginFetchResult> {
  // 复用常驻页面；页面已加载时绝不重新导航（导航=reload 会清空前端内存里的续期凭据）
  const fresh = !isPageAlive(ctx.providerId)
  const page = await ensureLivePage(ctx.providerId, ctx.dataDir, `${CONSOLE_BASE}/step-plan`)
  if (fresh) await page.waitForTimeout(2000)

  const url = page.url()
  if (/(login|signin|passport)/i.test(url)) {
    throw new PluginError('auth_expired', '浏览器会话已过期，请重新登录（详情页 → 更新凭证 → 浏览器登录）')
  }

    const nowSec = Math.floor(Date.now() / 1000)
    const fromSec = nowSec - 90 * 86400

    const planRes = await rpcInPage<PlanStatusResponse>(page, 'GetStepPlanStatus', {})
    if (planRes.status === 401 || planRes.status === 403) {
      throw new PluginError('auth_expired', '控制台鉴权失败，浏览器会话已过期，请重新登录')
    }
    const planStatus = planRes.data

    let availTokens: number | undefined
    const records: UsageRecord[] = []
    let pageNo = 1
    for (let i = 0; i < 50; i++) {
      const res = await rpcInPage<UsageHistoryResponse>(page, 'DevQueryUsageHistory', {
        fromTime: fromSec,
        toTime: nowSec,
        pageSize: 100,
        page: pageNo,
        quotaType: 1,
      })
      if (res.data?.availTokens !== undefined) availTokens = num(res.data.availTokens)
      const recs = res.data?.records ?? []
      records.push(...recs)
      if (recs.length < 100) break
      pageNo++
    }

    // Step Plan 套餐 Credits 用量（含模型明细）——注意：时间为毫秒
    // 分页不依赖 total 语义（可能是本页数或总数）：拉不满一页即视为最后一页
    const planRecords: StepPlanUsageRecord[] = []
    pageNo = 1
    for (let i = 0; i < 50; i++) {
      const res = await rpcInPage<StepPlanUsagesResponse>(page, 'QueryStepPlanUsages', {
        start_time: fromSec * 1000,
        to_time: nowSec * 1000,
        page: pageNo,
        page_size: 100,
      })
      const recs = res.data?.records ?? []
      planRecords.push(...recs)
      if (recs.length < 100) break
      pageNo++
    }

    let rateLimit: RateLimitResponse | null = null
    try {
      rateLimit = (await rpcInPage<RateLimitResponse>(page, 'QueryStepPlanRateLimit', {})).data
    } catch {
      /* 额度接口可选 */
    }

    let balance: { amount: number; currency: string } | undefined
    try {
      const bal = await rpcInPage<BalanceResponse>(page, 'QueryAccountBalance', {})
      const payment = num(bal.data?.payment)
      const voucher = num(bal.data?.voucher)
      if (payment !== undefined || voucher !== undefined) {
        balance = { amount: ((payment ?? 0) + (voucher ?? 0)) / 100, currency: 'CNY' }
      }
    } catch {
      /* 余额失败不影响主流程 */
    }

    let userInfo: UserInfoResponse | null = null
    try {
      userInfo = (await rpcInPage<UserInfoResponse>(page, 'UserInfo', {})).data
    } catch {
      /* 账户信息可选 */
    }

    // 会话可能已在前端定时器里续过期，刷新快照让重启后也能恢复
    await snapshotSession(ctx.providerId, ctx.dataDir).catch(() => {})

    return buildSnapshot(planStatus, planRecords, records, availTokens, balance, userInfo, rateLimit, nowSec, [])
  }

async function rpcDirect<T>(method: string, body: unknown, cookie: string): Promise<T> {
  try {
    return await fetchJson<T>(`${CONSOLE_BASE}${RPC_PATH}/${method}`, {
      method: 'POST',
      body,
      headers: {
        Cookie: cookie,
        Origin: CONSOLE_BASE,
        Referer: `${CONSOLE_BASE}/`,
        'connect-protocol-version': '1',
        'oasis-appid': '10300',
        'oasis-platform': 'web',
      },
      timeoutMs: 20_000,
      retries: 0,
    })
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', 'Cookie 鉴权失败：Oasis-Token 仅 30 分钟寿命且刷新后作废，请改用「浏览器登录」或重新粘贴新鲜 Cookie')
    }
    if (err.status === 404) {
      throw new PluginError('endpoint_changed', `控制台接口 ${method} 不存在（404），结构可能已变化`)
    }
    throw new PluginError('network', `控制台接口 ${method} 请求失败：${err.message}`)
  }
}

async function fetchViaPastedCookie(ctx: PluginContext, cookie: string): Promise<PluginFetchResult> {
  const notes: string[] = []

  let planStatus: PlanStatusResponse | null = null
  try {
    planStatus = await rpcDirect<PlanStatusResponse>('GetStepPlanStatus', {}, cookie)
  } catch (e) {
    if (e instanceof PluginError && e.code === 'auth_expired') throw e
    notes.push(`Step Plan 状态获取失败：${(e as Error).message}`)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const fromSec = nowSec - 90 * 86400
  let availTokens: number | undefined
  const records: UsageRecord[] = []
  let pageNo = 1
  for (let i = 0; i < 50; i++) {
    const res = await rpcDirect<UsageHistoryResponse>(
      'DevQueryUsageHistory',
      { fromTime: fromSec, toTime: nowSec, pageSize: 100, page: pageNo, quotaType: 1 },
      cookie
    )
    if (res.availTokens !== undefined) availTokens = num(res.availTokens)
    const recs = res.records ?? []
    records.push(...recs)
    if (recs.length < 100) break
    pageNo++
  }
  const planRecords: StepPlanUsageRecord[] = []
  try {
    pageNo = 1
    for (let i = 0; i < 50; i++) {
      const res = await rpcDirect<StepPlanUsagesResponse>(
        'QueryStepPlanUsages',
        { start_time: fromSec * 1000, to_time: nowSec * 1000, page: pageNo, page_size: 100 },
        cookie
      )
      const recs = res.records ?? []
      planRecords.push(...recs)
      if (recs.length < 100) break
      pageNo++
    }
  } catch (e) {
    if (e instanceof PluginError && e.code === 'auth_expired') throw e
    notes.push(`套餐用量获取失败：${(e as Error).message}`)
  }

  let rateLimit: RateLimitResponse | null = null
  try {
    rateLimit = await rpcDirect<RateLimitResponse>('QueryStepPlanRateLimit', {}, cookie)
  } catch {
    /* 额度接口可选 */
  }

  let balance: { amount: number; currency: string } | undefined
  try {
    const bal = await rpcDirect<BalanceResponse>('QueryAccountBalance', {}, cookie)
    const payment = num(bal.payment)
    const voucher = num(bal.voucher)
    if (payment !== undefined || voucher !== undefined) {
      balance = { amount: ((payment ?? 0) + (voucher ?? 0)) / 100, currency: 'CNY' }
    }
  } catch {
    /* 忽略 */
  }

  let userInfo: UserInfoResponse | null = null
  try {
    userInfo = await rpcDirect<UserInfoResponse>('UserInfo', {}, cookie)
  } catch {
    /* 账户信息可选 */
  }

  return buildSnapshot(planStatus, planRecords, records, availTokens, balance, userInfo, rateLimit, nowSec, notes)
}

// ---------- 插件入口 ----------

export const stepfunPlugin: ProviderPlugin = {
  id: 'stepfun',
  displayName: 'StepFun 阶跃星辰',
  icon: '/icons/stepfun.png',
  authMethods: ['apikey', 'browser-login', 'cookie'],
  scheduleDefaultSec: 3600,
  homepage: 'https://platform.stepfun.com',
  consoleUrl: 'https://platform.stepfun.com/step-plan',
  cookieGuide: {
    loginUrl: 'https://platform.stepfun.com/',
    steps: [
      '点击下方按钮打开 StepFun 开放平台，登录你的账号',
      '登录成功后，按 F12 打开浏览器开发者工具，切换到「网络 / Network」标签',
      '刷新页面（F5），在请求列表中点击任意一条 platform.stepfun.com 的请求',
      '在右侧「请求头 / Request Headers」中找到 Cookie 字段，整条复制',
      '粘贴到下方输入框，点击「验证并保存」，系统会立即同步一次并告知结果',
    ],
  },

  // 交互式登录：弹出真实浏览器，用户登录一次，会话持久化在 profile 目录
  async login(ctx: PluginContext): Promise<PluginLoginResult> {
    const pw = await importPlaywright(ctx)

    // 先释放无头保活实例占用的 profile，否则两个 Chromium 会互相冲掉 Cookie
    await closeSession(ctx.providerId).catch(() => {})

    // 本机 Chrome 打开（未装则回退内置 Chromium）；独立持久 profile，登录一次后快照+保活复用
    const context = await launchLoginWindow(pw, ctx.dataDir, ctx.providerId)

    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(`${CONSOLE_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      ctx.log('已打开浏览器，等待用户登录…')
      // 用户关闭登录窗口 → 立即中止，不用等满超时
      let browserClosed = false
      context.on('close', () => {
        browserClosed = true
      })

      const deadline = Date.now() + 180_000
      let sawToken = false
      while (Date.now() < deadline) {
        if (browserClosed) {
          return { ok: false, message: '浏览器窗口已关闭，登录已取消' }
        }
        // 循环内每个等待都设超时，防止页面无响应把整个流程挂死
        const remain = Math.max(1000, deadline - Date.now())
        await page.waitForTimeout(Math.min(2000, remain)).catch(() => {})
        const cookies = await withTimeout(
          context.cookies('https://platform.stepfun.com').catch(() => []),
          10_000,
          [] as Array<{ name: string; value: string }>
        )
        const token = cookies.find((c) => c.name === 'Oasis-Token')
        if (!token?.value) continue

        const exp = jwtExpMs(token.value)
        if (exp !== undefined && exp <= Date.now() + 60_000) continue
        sawToken = true

        // 关键：token 出现后前端还要完成 RefreshToken 握手，此时服务端会话可能尚未生效。
        // 等待握手稳定，然后跳到控制台用页内请求实测验证，通过才认为登录成功。
        await page.waitForTimeout(5000).catch(() => {})
        try {
          await page.goto(`${CONSOLE_BASE}/step-plan`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
          await page.waitForTimeout(4000).catch(() => {})
          const probe = await withTimeout<{ status?: number }>(rpcInPage<{ status?: number }>(page, 'UserInfo', {}), 15_000, { status: 0 })
          if (probe.status === 200) {
            markLoggedIn(ctx.dataDir, ctx.providerId)
            // 关闭前导出会话快照：session cookie 不会被 Chromium 落盘
            await persistStorageState(context, ctx.dataDir, ctx.providerId).catch(() => {})
            // 登录浏览器可以关了；改由常驻无头保活页面维持 token 续期
            await context.close().catch(() => {})
            await startKeepAlive(ctx.providerId, ctx.dataDir, `${CONSOLE_BASE}/step-plan`)
            return { ok: true, message: '登录成功，会话已保存并启动保活，后续同步自动保持' }
          }
          ctx.log(`会话尚未生效（UserInfo ${probe.status}），继续等待…`)
        } catch {
          /* 页面还在跳转，继续等 */
        }
      }
      return {
        ok: false,
        message: sawToken ? '检测到登录但会话未生效（3 分钟超时），请重试' : '登录超时（3 分钟未检测到登录）',
      }
    } finally {
      await context.close().catch(() => {})
    }
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    // 1. API Key：官方账户接口
    if (cred.kind === 'apikey') {
      let account: StepFunAccount
      try {
        account = await fetchAccountViaApi(cred.apiKey, API_BASE)
      } catch (e) {
        const err = e as Error & { status?: number }
        if (err.status === 401 || err.status === 403) {
          throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
        }
        throw new PluginError('network', `账户接口请求失败：${err.message}`)
      }
      if (account.balance === undefined) {
        throw new PluginError('parse', '账户接口响应缺少 balance 字段')
      }
      const models = await fetchModelsViaApi(cred.apiKey, API_BASE)
      return {
        account: {
          userName: 'API 用户',
          maskedContact: 'sk-••••' + cred.apiKey.slice(-4),
          region: 'CN',
        },
        balance: { amount: account.balance, currency: 'CNY' },
        plan: { name: account.type === 'postpaid' ? '后付费' : '预付费按量', currency: 'CNY' },
        availableModels: models,
        notes: [
          `账户类型 ${account.type ?? 'unknown'}`,
          `累计充值 ¥${account.total_cash_balance ?? 0} / 累计赠送 ¥${account.total_voucher_balance ?? 0}`,
          models ? `可见模型 ${models.length} 个` : '模型列表获取失败，沿用上次结果',
          'Step Plan 套餐额度需要 Cookie 或浏览器登录模式采集',
        ],
      }
    }

    // 2. 持久浏览器会话（推荐）：profile 存在且已登录
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      // 未登录前不起无头实例：空 profile 会占住目录，把随后登录写入的 Cookie 冲掉
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      return fetchViaBrowser(ctx)
    }

    // 3. 粘贴的 Cookie（临时）
    if (cred.kind === 'cookie') {
      const cookie = normalizeCookie(cred.cookie)
      if (!cookie) {
        throw new PluginError('not_configured', 'Cookie 为空，请先完成获取引导')
      }
      return fetchViaPastedCookie(ctx, cookie)
    }

    throw new PluginError('not_configured', `StepFun 插件不支持的凭证类型：${(cred as { kind: string }).kind}`)
  },
}
