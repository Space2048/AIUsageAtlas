import { fetchJson } from '~~/server/utils/http'
import { isLoggedIn, markLoggedIn } from '~~/server/utils/browser-profile'
import { closeSession, ensureLivePage, isPageAlive, launchLoginWindow, persistStorageState, snapshotSession, startKeepAlive } from '~~/server/utils/browser-session'
import {
  PluginError,
  type PluginContext,
  type PluginFetchResult,
  type PluginModelUsage,
  type PluginUsageDay,
  type PluginWindow,
  type ProviderPlugin,
} from './types'

/**
 * 智谱 BigModel 插件
 *
 * 2026-10-22 核对：控制台同源的 /api/monitor/*、/api/biz/*、/api/finance/* **不认会话 Cookie**，
 * 只认 Authorization（匿名/仅 Cookie 均回 HTTP 200 + code:1001）。登录后的 token 写在
 * .bigmodel.cn 的 bigmodel_token_* Cookie 里且 JS 可读，浏览器模式据此自拼 Bearer，
 * 与 Key 模式共用全部采集逻辑（Key 模式为用户 API Key，浏览器模式为登录 token）：
 * · GET /api/monitor/usage/model-usage?startTime=&endTime=   —— 按模型用量时序，7 天分片
 *    （30 天+ code:500），小时槽聚合到日；只有 token、无消费金额
 * · GET /api/monitor/credit-usage/usage-detail?…             —— Code Plan 积分平面（优先）：
 *    granularity DAY、Asia/Shanghai，每模型每日 uncached/cached/output 的 token 与积分拆分
 * · GET /api/monitor/usage/quota/limit                       —— 额度桶（unit3=5小时、unit6=周）
 * · GET /api/biz/account/query-customer-account-report       —— 余额/累计充值/累计消费（CNY）
 * · GET /api/biz/subscription/list                           —— 订阅：productName（如 GLM Coding
 *    Lite）、standardPrice=价格、autoRenew、valid="起-止"（起点=下一次续费日）、status=VALID
 * · GET /api/finance/expenseBill/expenseBillListByDay?billingMonth=YYYY-MM
 *    —— 按日真实账单（settlementAmount 按 billingDate 聚合），订阅扣费与按量消费都在里面；
 *    出账有 T+1~2 延迟，当日费用可能次日才出现。分页 pageNum/pageSize 一起带上。
 * 社区代码里的 POST /api/balance 确实已失效（404），勿复活。
 *
 * 2026-10-16 起标准 Key 与 Coding Plan Key 不通用，Coding Plan 基座是 /api/coding/paas/v4，
 * Key 模式下两个基座都要试：只试标准基座会把合法的 Coding Plan Key 误判成失效。
 * 浏览器模式以订阅状态判定计费平面，不依赖基座探测（会话调不动推理侧 /models）。
 */

const BASES = [
  { label: '标准推理', path: '/api/paas/v4/models' },
  { label: 'GLM Coding Plan', path: '/api/coding/paas/v4/models' },
]

const API = 'https://open.bigmodel.cn/api'
// 保活/登录落点：套餐概览页（打开即在 open.bigmodel.cn 同源，/api/* 走 Cookie）
const CONSOLE_PAGE = 'https://open.bigmodel.cn/coding-plan/personal/overview'
const LOGIN_URL = /(passport|account\.|\/auth\/|\/login|signin)/i

// 用量按 7 天分片回填的窗口：接口单次上限 7 天（30 天实测 code:500）
const BACKFILL_DAYS = 90
const SLICE_DAYS = 7
// 按日账单按月拉取，上限 6 个月（与用量窗口跨度对齐）
const BILL_MONTHS_CAP = 6

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>
  model?: string[]
}

// 平台统一包 {code,msg,data}，HTTP 200 + code 500 实测存在，只有 code 200 才算成功
interface Envelope<T> {
  code?: number
  msg?: string
  data?: T
}

// /biz/customer/getCustomerInfo 的 data（浏览器登录态下的账户身份）
interface CustomerInfo {
  customerName?: string
  nickName?: string
  phoneNumber?: string
  email?: string | null
  userType?: string
}

// 传输层：Key 模式 = fetchJson + Bearer；浏览器模式 = 页内 fetch + 会话 Cookie
type JsonGet = <T>(url: string) => Promise<T>

// Code Plan 积分平面（credit-usage/usage-detail）：按天、按模型，token 与积分双拆分
interface CreditDetailData {
  summary?: {
    totalCredits?: { value?: string | number }
    cacheHitRate?: { value?: string | number }
    offPeakUsageRate?: { value?: string | number }
  }
  modelUsage?: {
    xTime?: string[]
    totalUsage?: { totalTokens?: number | string; totalCredits?: number | string }
    modelDataList?: Array<{
      modelCode?: string
      modelName?: string
      uncachedInputTokensUsage?: number[]
      cachedInputTokensUsage?: number[]
      outputTokensUsage?: number[]
    }>
  }
}

interface UsageBundle {
  usage: PluginUsageDay[]
  models: PluginModelUsage[]
  window: { from: string; to: string }
  totalTokens: number
  failedSlices: number
  source: 'credit' | 'token'
  creditsNote?: string
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function apiGet<T>(get: JsonGet, path: string): Promise<T | null> {
  try {
    const res = await get<Envelope<T>>(`${API}${path}`)
    return res?.code === 200 ? ((res.data ?? null) as T | null) : null
  } catch {
    return null
  }
}

// 整包响应（如账单列表直接把 code/total/rows 平铺在顶层，没有 data 包装）
async function apiBody<T>(get: JsonGet, path: string): Promise<T | null> {
  try {
    const res = await get<{ code?: number } & T>(`${API}${path}`)
    return res && (res.code === undefined || res.code === 200) ? res : null
  } catch {
    return null
  }
}

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把 [今天-89, 今天] 切成互不重叠的 7 天分片（本地日历日） */
function usageSlices(): Array<{ from: string; to: string }> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const count = Math.ceil(BACKFILL_DAYS / SLICE_DAYS)
  const out: Array<{ from: string; to: string }> = []
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(today)
    start.setDate(start.getDate() - i * SLICE_DAYS)
    const end = new Date(start)
    end.setDate(end.getDate() + SLICE_DAYS - 1)
    if (end.getTime() > today.getTime()) end.setTime(today.getTime())
    out.push({ from: dayStr(start), to: dayStr(end) })
  }
  return out
}

/** 从起始日期所在月到当月（含），最多 BILL_MONTHS_CAP 个月，供按日账单逐月拉取 */
function billMonths(fromDate: string): Array<{ y: number; m: number }> {
  const start = new Date(`${fromDate.slice(0, 7)}-01T00:00:00`)
  const now = new Date()
  const out: Array<{ y: number; m: number }> = []
  for (let d = new Date(now.getFullYear(), now.getMonth(), 1); d.getTime() >= start.getTime() && out.length < BILL_MONTHS_CAP; d.setMonth(d.getMonth() - 1)) {
    out.push({ y: d.getFullYear(), m: d.getMonth() + 1 })
  }
  return out.reverse()
}

interface ModelUsageData {
  x_time?: string[]
  tokensUsage?: number[]
  modelCallCount?: number[]
  modelDataList?: Array<{ modelName?: string; tokensUsage?: number[] }>
  totalUsage?: { totalTokensUsage?: number; totalModelCallCount?: number }
  granularity?: string
}

interface QuotaData {
  level?: string
  limits?: Array<{
    type?: string
    unit?: number
    number?: number
    usage?: number
    currentValue?: number
    percentage?: number
    nextResetTime?: number
  }>
}

interface AccountReport {
  balance?: number | string
  availableBalance?: number | string
  rechargeAmount?: number | string
  totalSpendAmount?: number | string
}

interface SubRow {
  productName?: string
  productBigTitle?: string
  status?: string
  valid?: string
  autoRenew?: number
  initialPrice?: number
  standardPrice?: number
}

interface BillRow {
  billingDate?: string
  settlementAmount?: number | string
  currency?: string
}

// unit 枚举来自控制台「用量统计」页 bundle：3=小时、6=周
function quotaLabel(t: string | undefined, unit: number | undefined, n: number | undefined): string {
  const kind = t === 'TOKENS_LIMIT' ? '使用额度' : '额度'
  if (unit === 3) return `${n ?? 5}小时${kind}`
  if (unit === 6) return (n === 1 || n === undefined ? '每周' : `每${n}周`) + kind
  return `额度桶(unit ${unit ?? '?'})`
}

// 分片顺序拉取 + 失败隔秒重试：并发突发会触发平台侧偶发 code:500（同一分片顺序请求正常）
async function fetchSlices<T>(get: JsonGet, build: (s: { from: string; to: string }) => string): Promise<Array<T | null>> {
  const out: Array<T | null> = []
  for (const s of usageSlices()) {
    const url = build(s)
    let d = await apiGet<T>(get, url)
    if (!d) {
      await sleep(1000)
      d = await apiGet<T>(get, url)
    }
    out.push(d)
  }
  return out
}

/** Code Plan 积分平面：有积分包账号的首选数据源（billing=subscription） */
async function fetchCreditUsage(get: JsonGet): Promise<UsageBundle | null> {
  const results = await fetchSlices<CreditDetailData>(get, (s) =>
    `/monitor/credit-usage/usage-detail?usageType=MODEL&type=1&startTime=${encodeURIComponent(`${s.from} 00:00:00`)}&endTime=${encodeURIComponent(
      `${s.to} 23:59:59`
    )}`
  )
  const ok = results.filter((r): r is CreditDetailData => !!r)
  if (!ok.length) return null

  const daily = new Map<string, { uncached: number; cached: number; output: number }>()
  const modelDaily = new Map<string, PluginModelUsage>()
  let totalTokens = 0
  let totalCredits = 0
  let cachedSum = 0
  let uncachedSum = 0
  for (const d of ok) {
    const mu = d.modelUsage
    totalTokens += num(mu?.totalUsage?.totalTokens) ?? 0
    totalCredits += num(mu?.totalUsage?.totalCredits) ?? 0
    const xs = mu?.xTime ?? []
    for (const m of mu?.modelDataList ?? []) {
      const code = m.modelCode || m.modelName
      if (!code) continue
      xs.forEach((day, i) => {
        const date = String(day).slice(0, 10)
        const unc = num(m.uncachedInputTokensUsage?.[i]) ?? 0
        const cached = num(m.cachedInputTokensUsage?.[i]) ?? 0
        const outTok = num(m.outputTokensUsage?.[i]) ?? 0
        uncachedSum += unc
        cachedSum += cached
        const dayAcc = daily.get(date) ?? { uncached: 0, cached: 0, output: 0 }
        dayAcc.uncached += unc
        dayAcc.cached += cached
        dayAcc.output += outTok
        daily.set(date, dayAcc)
        const key = `${date}|${code}`
        const row = modelDaily.get(key) ?? { date, modelId: code, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, billing: 'subscription' as const }
        row.inputTokens = (row.inputTokens ?? 0) + unc
        row.cachedTokens = (row.cachedTokens ?? 0) + cached
        row.outputTokens = (row.outputTokens ?? 0) + outTok
        modelDaily.set(key, row)
      })
    }
  }

  const dates = [...daily.keys()].sort()
  if (!dates.length) return null
  const usage: PluginUsageDay[] = dates.map((date) => {
    const d = daily.get(date)!
    return {
      date,
      inputTokens: d.uncached,
      cachedTokens: d.cached,
      outputTokens: d.output,
      // 积分平面不给请求数；消费金额优先由按日账单覆盖，无账单时由余额差分补当日
      requests: 0,
      costAmount: 0,
      currency: 'CNY',
      billing: 'subscription' as const,
    }
  })
  const hitRate = cachedSum + uncachedSum > 0 ? (cachedSum / (cachedSum + uncachedSum)) * 100 : null
  return {
    usage,
    models: [...modelDaily.values()],
    window: { from: dates[0], to: dates.at(-1)! },
    totalTokens,
    failedSlices: results.length - ok.length,
    source: 'credit',
    creditsNote: `Code Plan 积分：窗口内消耗 ${totalCredits.toFixed(2)}${hitRate !== null ? `，缓存命中率 ${hitRate.toFixed(1)}%` : ''}`,
  }
}

/** token 平面（model-usage）：无积分包账号（纯按量）或积分平面不可用时的回退 */
async function fetchTokenUsage(get: JsonGet, billing: 'subscription' | 'payg'): Promise<UsageBundle | null> {
  const results = await fetchSlices<ModelUsageData>(get, (s) =>
    `/monitor/usage/model-usage?startTime=${encodeURIComponent(`${s.from} 00:00:00`)}&endTime=${encodeURIComponent(`${s.to} 23:59:59`)}`
  )
  const ok = results.filter((r): r is ModelUsageData => !!r)
  // 个别分片失败不整批丢弃：每次同步都全量重建 90 天窗口，缺口下轮自愈
  if (!ok.length) return null

  const daily = new Map<string, { tokens: number; requests: number }>()
  const modelDaily = new Map<string, PluginModelUsage>()
  for (const d of ok) {
    const xs = d.x_time ?? []
    xs.forEach((slot, i) => {
      const date = String(slot).slice(0, 10)
      const day = daily.get(date) ?? { tokens: 0, requests: 0 }
      day.tokens += num(d.tokensUsage?.[i]) ?? 0
      day.requests += num(d.modelCallCount?.[i]) ?? 0
      daily.set(date, day)
    })
    for (const m of d.modelDataList ?? []) {
      if (!m.modelName) continue
      xs.forEach((slot, i) => {
        const date = String(slot).slice(0, 10)
        const key = `${date}|${m.modelName}`
        const row = modelDaily.get(key) ?? { date, modelId: m.modelName!, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, billing }
        // 接口只有 token 总量、不拆输入/输出：记在 input_tokens 上以保持日总量正确
        row.inputTokens = (row.inputTokens ?? 0) + (num(m.tokensUsage?.[i]) ?? 0)
        modelDaily.set(key, row)
      })
    }
  }

  const usage: PluginUsageDay[] = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, r]) => ({
      date,
      inputTokens: r.tokens,
      outputTokens: 0,
      cachedTokens: 0,
      requests: r.requests,
      costAmount: 0,
      currency: 'CNY',
      billing,
    }))

  const dates = [...daily.keys()].sort()
  if (!dates.length) return null
  return {
    usage,
    models: [...modelDaily.values()],
    // 区间快照：同步时整体替换该区间旧行，跨分片/跨同步不重复累加
    window: { from: dates[0], to: dates.at(-1)! },
    totalTokens: ok.reduce((a, d) => a + (num(d.totalUsage?.totalTokensUsage) ?? 0), 0),
    failedSlices: results.length - ok.length,
    source: 'token',
  }
}

/** 有积分包（Code Plan）优先积分平面，否则 token 平面；两者都失败返回 null */
async function fetchUsage(get: JsonGet, isCoding: boolean): Promise<UsageBundle | null> {
  const credit = await fetchCreditUsage(get)
  if (credit) return credit
  return fetchTokenUsage(get, isCoding ? 'subscription' : 'payg')
}

/** 订阅信息：价格 / 下次续费日 / 自动续费（status=VALID 的有效订阅） */
async function fetchSubscription(get: JsonGet): Promise<{
  name: string
  price: number | undefined
  renewalDate: string | undefined
  autoRenew: boolean
} | null> {
  const rows = await apiGet<SubRow[]>(get, '/biz/subscription/list')
  if (!Array.isArray(rows)) return null
  const hit = rows.find((r) => r.status === 'VALID')
  if (!hit) return null
  const price = num(hit.standardPrice) ?? num(hit.initialPrice)
  // valid="起-止"，起点即当前周期结束/下一周期开始（下一次扣费续费日）
  const renewalDate = /^(\d{4}-\d{2}-\d{2})/.exec(String(hit.valid ?? ''))?.[1]
  return {
    name: hit.productName || hit.productBigTitle || 'GLM Coding Plan',
    price,
    renewalDate,
    autoRenew: hit.autoRenew === 1,
  }
}

/**
 * 按日真实账单：逐月拉 expenseBillListByDay，settlementAmount 按 billingDate 聚合。
 * 任一月失败整批返回 null——缺月的费用会被误当 0，且会跳过余额差分兜底。
 */
async function fetchBills(get: JsonGet, months: Array<{ y: number; m: number }>): Promise<{ map: Map<string, number>; rows: number } | null> {
  const map = new Map<string, number>()
  let rows = 0
  for (const { y, m } of months) {
    const mm = String(m).padStart(2, '0')
    const path = `/finance/expenseBill/expenseBillListByDay?billingMonth=${y}-${mm}&pageNum=1&pageSize=1000`
    let body = await apiBody<{ total?: number; rows?: BillRow[] }>(get, path)
    if (!body) {
      await sleep(1000)
      body = await apiBody<{ total?: number; rows?: BillRow[] }>(get, path)
    }
    if (!body) return null
    const list = body.rows ?? []
    if (typeof body.total === 'number' && body.total > list.length) return null // 分页截断视为不可信
    for (const r of list) {
      const date = String(r.billingDate ?? '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      map.set(date, (map.get(date) ?? 0) + (num(r.settlementAmount) ?? 0))
    }
    rows += list.length
  }
  return { map, rows }
}

/**
 * 统一采集（传输无关）：用量（积分平面优先）+ 配额 + 余额 + 订阅 + 按日账单。
 * billing 决定 token 平面回退时的计费标记；mask 仅 Key 模式有（会话模式保留原联系方式）。
 */
async function collectAll(
  get: JsonGet,
  notes: string[],
  isCoding: boolean,
  mask?: string,
  subPrefetched?: Awaited<ReturnType<typeof fetchSubscription>>
): Promise<PluginFetchResult> {
  const [usage, quota, report, sub] = await Promise.all([
    fetchUsage(get, isCoding),
    apiGet<QuotaData>(get, '/monitor/usage/quota/limit'),
    apiGet<AccountReport>(get, '/biz/account/query-customer-account-report'),
    subPrefetched !== undefined ? Promise.resolve(subPrefetched) : fetchSubscription(get),
  ])
  // 按日账单依赖用量窗口的起始月，顺序执行
  const bills = usage ? await fetchBills(get, billMonths(usage.window.from)) : null

  const res: PluginFetchResult = { notes }

  if (usage) {
    if (bills) {
      // 真实账单覆盖每日消费（订阅扣费与按量消费都在内），有账单时余额差分自动让位
      for (const row of usage.usage) {
        const cost = bills.map.get(row.date)
        if (cost !== undefined) row.costAmount = Number(cost.toFixed(6))
      }
      // 纯扣费日（如订阅续费日）没有用量行也要入账，否则费用凭空消失
      const have = new Set(usage.usage.map((r) => r.date))
      for (const [date, cost] of bills.map) {
        if (!have.has(date) && cost > 0) {
          usage.usage.push({
            date,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            requests: 0,
            costAmount: Number(cost.toFixed(6)),
            currency: 'CNY',
            billing: 'subscription',
          })
        }
      }
      usage.usage.sort((a, b) => a.date.localeCompare(b.date))
      notes.push(
        `按日账单回填 ${bills.rows} 行 / ${bills.map.size} 天（/finance/expenseBill，出账 T+1~2，当日费用可能次日才出现）`
      )
    } else {
      notes.push('按日账单未取全（任一月失败整批放弃），当日费用改由余额差分推算')
    }
    res.usageDaily = usage.usage
    res.modelUsage = usage.models
    res.modelUsageWindow = usage.window
    res.usageWindow = usage.window
    notes.push(
      `用量回填 ${usage.usage.length} 天 / ${usage.models.length} 行模型明细（${
        usage.source === 'credit' ? 'Code Plan 积分平面' : 'token 平面'
      }，近 ${BACKFILL_DAYS} 天 7 天分片，合计 ${usage.totalTokens.toLocaleString('en-US')} tokens${
        usage.failedSlices ? `，${usage.failedSlices} 个分片失败、下轮同步自愈` : ''
      }）`
    )
    if (usage.creditsNote) notes.push(usage.creditsNote)
  } else {
    notes.push('用量接口未取得（积分/token 平面分片请求均失败，保留上次数据）')
  }

  if (quota?.limits?.length) {
    res.windows = quota.limits.map((l) => ({
      name: quotaLabel(l.type, l.unit, l.number),
      // 滚动窗口（如5小时额度）的 percentage 可能缺省：用 已用/上限 兜底
      usedPct: Math.min(100, Math.max(0, num(l.percentage) ?? (num(l.usage) ? ((num(l.currentValue) ?? 0) / num(l.usage)!) * 100 : 0))),
      usedValue: num(l.currentValue) ?? null,
      limitValue: num(l.usage) ?? null,
      unit: 'credits',
      resetAt: num(l.nextResetTime) ? new Date(num(l.nextResetTime)!).toISOString() : null,
    }))
    notes.push(`配额窗口 ${res.windows.length} 个：${res.windows.map((w) => w.name).join('、')}${quota.level ? `（套餐档位 ${quota.level}）` : ''}`)
  } else {
    notes.push('配额窗口未取得（quota/limit 无返回，保留上次数据）')
  }

  if (report) {
    const balance = num(report.balance) ?? num(report.availableBalance)
    if (balance !== undefined) res.balance = { amount: balance, currency: 'CNY' }
    notes.push(
      `账户（CNY）：可用 ${balance ?? '?'}，累计充值 ${num(report.rechargeAmount) ?? '?'},累计消费 ${num(report.totalSpendAmount) ?? '?'}`
    )
  } else {
    notes.push('账户报表未取得（query-customer-account-report 无返回，保留上次余额）')
  }

  if (sub) {
    res.plan = {
      name: sub.name,
      price: sub.price,
      currency: 'CNY',
      renewalDate: sub.renewalDate ?? null,
      autoRenew: sub.autoRenew,
      unknownFields: [],
    }
    notes.push(
      `订阅：${sub.name}${sub.price !== undefined ? ` ¥${sub.price}/期` : ''}${sub.renewalDate ? `，续费 ${sub.renewalDate}` : ''}，自动续费${sub.autoRenew ? '开' : '关'}（subscription/list）`
    )
  } else {
    // 无有效订阅：按量账户的这些字段确实无从谈起，仍标未获取到（不拿 0/false 冒充）
    res.plan = {
      name: isCoding ? 'GLM Coding Plan' : '按量付费',
      currency: 'CNY',
      unknownFields: ['price', 'renewalDate', 'autoRenew'],
    }
    notes.push('未取到有效订阅（subscription/list 无 VALID 记录），价格/续费/自动续费标未获取到')
  }

  if (mask) {
    res.account = {
      userName: 'API 用户',
      maskedContact: mask,
      region: 'CN',
    }
  }
  return res
}

async function probeBase(get: JsonGet, path: string): Promise<{ ok: boolean; status?: number; models: string[] }> {
  try {
    const res = await get<ModelsResponse>(`https://open.bigmodel.cn${path}`)
    const rows = res.data ?? res.model ?? []
    const models = rows
      .map((m) => (typeof m === 'string' ? m : m.id ?? ''))
      .filter(Boolean) as string[]
    return { ok: true, models }
  } catch (e) {
    const err = e as Error & { status?: number }
    return { ok: false, status: err.status, models: [] }
  }
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  const get: JsonGet = <T,>(url: string): Promise<T> =>
    fetchJson<T>(url, { headers: { Authorization: `Bearer ${apiKey}` } })

  const results = await Promise.all(BASES.map(async (b) => ({ base: b, ...(await probeBase(get, b.path)) })))
  const accepted = results.filter((r) => r.ok)

  if (!accepted.length) {
    const first = results[0]
    if (first.status === 401 || first.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${first.status}，标准与 Coding Plan 两个基座都被拒）`)
    }
    throw new PluginError('network', `Key 校验请求失败（HTTP ${first.status ?? '无响应'}）`)
  }

  const notes: string[] = []
  notes.push(`Key 可用基座：${accepted.map((a) => a.base.label).join('、')}`)
  for (const a of accepted) {
    notes.push(
      a.models.length
        ? `${a.base.label} 可见模型 ${a.models.length} 个：${a.models.slice(0, 8).join('、')}${a.models.length > 8 ? ' …' : ''}`
        : `${a.base.label} 模型列表为空（该基座未返回可读列表，仅证明 Key 有效）`
    )
  }
  const isCoding = accepted.some((a) => a.base.path.includes('/coding/'))
  ctx.log(`Key 有效（${notes[0]?.replace('Key 可用基座：', '') ?? '未知'}）`)

  const res = await collectAll(get, notes, isCoding, `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`)
  // 两个基座的模型高度重叠，取并集去重即可；浏览器模式不动该字段（沿用上次结果）
  res.availableModels = [...new Set(accepted.flatMap((a) => a.models))]
  return res
}

// ---------- 浏览器登录模式：同源 Cookie 作为第二传输层 ----------

// 控制台 /api/* 只认 Authorization，会话 Cookie 本身不带身份（2026-10-22 实测：
// 仅带 Cookie 时 code:1001「Header中未收到Authorization参数」）。SPA 的做法是读
// document.cookie 里的 bigmodel_token_* 再拼 Bearer，浏览器模式照抄这一步。
async function readSessionToken(page: import('playwright').Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const hit = document.cookie
        .split(';')
        .map((c) => c.trim())
        .find((c) => /^bigmodel_token/i.test(c))
      return hit ? hit.slice(hit.indexOf('=') + 1) : null
    })
    .catch(() => null)
}

async function fetchInPage<T>(page: import('playwright').Page, url: string, token?: string): Promise<T> {
  const call = page.evaluate(async ([u, auth]) => {
    const res = await fetch(u as string, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    })
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
  }, [url, token] as [string, string | undefined]) as Promise<T>
  return Promise.race([call, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`请求超时（${url}）`)), 30_000))])
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

  const token = await readSessionToken(page)
  if (!token) {
    throw new PluginError('auth_expired', 'profile 里没有 bigmodel_token_* Cookie，会话已失效，请重新浏览器登录')
  }

  const get: JsonGet = <T,>(url: string): Promise<T> => fetchInPage<T>(page, url, token)

  // 会话有效性 + 身份 + 计费平面预判（订阅能读=会话可用；顺带拿 sub 避免二次请求）
  let sub: Awaited<ReturnType<typeof fetchSubscription>>
  let customer: CustomerInfo | null = null
  try {
    const who = await get<Envelope<CustomerInfo>>(`${API}/biz/customer/getCustomerInfo`)
    // 匿名请求也是 HTTP 200，只有 code:1001 说明 token 没换成身份
    if (who?.code === 1001) {
      throw new PluginError('auth_expired', '控制台会话已失效（业务码 1001：请求未带上登录身份），请重新浏览器登录')
    }
    customer = who?.code === 200 ? (who.data ?? null) : null
    sub = await fetchSubscription(get)
  } catch (e) {
    if (e instanceof PluginError) throw e
    const s = (e as { status?: number }).status
    if (s === 401 || s === 403) {
      throw new PluginError('auth_expired', `控制台会话已失效（HTTP ${s}），请重新浏览器登录`)
    }
    sub = null
  }

  const notes: string[] = []
  const isCoding = !!sub
  const res = await collectAll(get, notes, isCoding, undefined, sub)
  if (customer) {
    res.account = {
      userName: customer.nickName || customer.customerName || '控制台用户',
      maskedContact: customer.phoneNumber ?? '',
      region: 'CN',
    }
    notes.push(`账户身份：${res.account.userName}${customer.userType ? `（${customer.userType}）` : ''}（getCustomerInfo）`)
  }
  notes.push('浏览器会话采集：模型列表与基座探测需 Bearer，沿用 API Key 模式的结果（availableModels 不刷新）')
  ctx.log(`浏览器会话有效${sub ? `，订阅 ${sub.name}` : '（未读到订阅）'}`)

  await snapshotSession(ctx.providerId, ctx.dataDir).catch(() => {})
  return res
}

async function importPlaywright(ctx: PluginContext) {
  try {
    return await import('playwright')
  } catch {
    throw new PluginError('not_configured', '未安装 playwright：npm i -D playwright && npx playwright install chromium')
  }
}

export const bigmodelPlugin: ProviderPlugin = {
  id: 'bigmodel',
  displayName: 'BigModel 智谱',
  icon: '/icons/bigmodel.png',
  authMethods: ['apikey', 'browser-login'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://open.bigmodel.cn',
  consoleUrl: CONSOLE_PAGE,

  async login(ctx: PluginContext): Promise<{ ok: boolean; message: string }> {
    const pw = await importPlaywright(ctx)
    // 先释放可能正被无头保活实例占用的 profile（双实例同开会互冲 Cookie）
    await closeSession(ctx.providerId).catch(() => {})
    const context = await launchLoginWindow(pw, ctx.dataDir, ctx.providerId)
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(CONSOLE_PAGE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      ctx.log('已打开智谱控制台，等待登录…')

      let closed = false
      context.on('close', () => {
        closed = true
      })
      const deadline = Date.now() + 240_000
      while (Date.now() < deadline) {
        if (closed) return { ok: false, message: '浏览器窗口已关闭，登录已取消' }
        await page.waitForTimeout(2500).catch(() => {})
        const ok = await page
          .evaluate(async () => {
            try {
              // 登录后 token 落在 .bigmodel.cn 的 bigmodel_token_*（JS 可读），
              // 但 /api/* 只认 Authorization，光带 Cookie 仍是 code:1001，必须自己拼 Bearer
              const hit = document.cookie
                .split(';')
                .map((c) => c.trim())
                .find((c) => /^bigmodel_token/i.test(c))
              if (!hit) return false
              const r = await fetch('https://open.bigmodel.cn/api/biz/customer/getCustomerInfo', {
                credentials: 'include',
                headers: { Accept: 'application/json', Authorization: `Bearer ${hit.slice(hit.indexOf('=') + 1)}` },
              })
              const j = (await r.json()) as { code?: number } | null
              return j?.code === 200
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
    if (cred.kind === 'apikey') return fetchViaApiKey(ctx, cred.apiKey)
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      // 没登录成功前不要起无头实例：空 profile 会占住目录，把随后登录写入的 Cookie 冲掉
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      return fetchViaBrowser(ctx)
    }
    throw new PluginError('not_configured', '凭证类型不支持')
  },
}
