import { createHmac } from 'node:crypto'
import { fetchJson } from '~~/server/utils/http'
import { isLoggedIn } from '~~/server/utils/browser-profile'
import {
  captureApiTraffic,
  closeSession,
  ensureLivePage,
  fetchInPageJson,
  isPageAlive,
  runInteractiveLogin,
} from '~~/server/utils/browser-session'
import {
  PluginError,
  type PluginContext,
  type PluginFetchResult,
  type PluginModelUsage,
  type PluginUsageDay,
  type ProviderPlugin,
} from './types'

/**
 * 火山引擎插件（火山方舟 Ark：豆包等模型的推理平台）
 *
 * 2026-10-21 官方文档核对（docs.volcengine.com/docs/82379）：方舟提供官方 OpenAPI，
 * **仅支持 Access Key（AK/SK 签名）**，不需要浏览器会话：
 * · POST https://ark.cn-beijing.volcengineapi.com/?Action=GetInferenceUsage&Version=2024-01-01
 *    Body {StartTime, EndTime(yyyy-MM-dd 北京时), QueryInterval: Day|Hour, Filters[]}；
 *    响应为列式 {Fields:[{Name,Type}], Data: string[][]}，默认列 AccountID/Day/Hour/
 *    InputTokens/OutputTokens/TotalTokens/ReqCnt；Filters 传 {Key, Values:[]} 可把该列
 *    加进返回（不过滤）——用 BillingStatus + ModelName 即可同时拿到计费平面与模型维度：
 *    BillingStatus: normal(按量后付费) / free_for_model_unit(模型单元) / free_for_free_quota /
 *    free_for_limit_boundary / free_for_viptier(TPM保障包) / no_need_billing(体验)。
 * · POST ?Action=GetUsageDetails（AgentPlan 套餐明细：Details[]，WithinPlan/OutsideOfPlan、
 *    Time(毫秒)、ObjectName、Unit(Tokens/Images)、Usage）—— 与推理用量存在重叠，仅作核对，
 *    v1 不入库避免双计。
 * · BFF-RPC（控制台会话）仍保留为浏览器登录备选通道：GetConsoleUser 等。
 * 注意：2026-08-12 后创建的 API Key 的用量过滤要用 ApikeyID（资源 ID），本插件用
 * BillingStatus/ModelName 的 Values:[] 空过滤取列，不涉及该限制。
 */

const REGION = 'cn-beijing'
const CONSOLE_PAGE = `https://ark.volcengine.com/region:${REGION}/overview`
const USAGE_PAGE = `https://ark.volcengine.com/region:${REGION}/usageTracking`
const LOGIN_URL = /(passport|login|signin|oauth|sign-?up)/i

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

async function ensureSession(ctx: PluginContext): Promise<import('playwright').Page> {
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
  return page
}

async function fetchViaBrowser(ctx: PluginContext): Promise<PluginFetchResult> {
  const page = await ensureSession(ctx)
  const notes: string[] = []
  const res: PluginFetchResult = { notes }

  // 账号（BFF Action：GetConsoleUser）
  const user = await fetchInPageJson(
    page,
    `/ark/bff/api/${REGION}/2024-01-29/GetConsoleUser`,
    { method: 'POST', body: {} }
  )
  if (user.status === 401 || user.status === 403) {
    throw new PluginError('auth_expired', `控制台会话已失效（HTTP ${user.status}），请重新浏览器登录`)
  }
  if (user.status === 200 && user.data && typeof user.data === 'object') {
    const email = String(deepFind(user.data, ['Email', 'email', 'Mail']) ?? '')
    const name = String(deepFind(user.data, ['Name', 'name', 'DisplayName', 'AccountName']) ?? '')
    res.account = {
      userName: name || '火山用户',
      maskedContact: email ? email.replace(/^(.).*?(@.*)$/s, '$1***$2') : '',
      region: 'CN',
    }
    notes.push(`账号：${name || '(无名)'}${email ? ` / ${email.slice(0, 3)}***${email.slice(-6)}` : ''}`)
    // 订阅信息探测（方舟有推理套餐/编码套餐面板）：语义键名找不到就标未获取到
    const plan = deepFind(user.data, ['PlanName', 'planName', 'Plan'])
    const renewal = deepFind(user.data, ['ExpireTime', 'expireTime', 'ExpiredAt', 'SubscriptionExpiredAt'])
    res.plan = {
      name: typeof plan === 'string' && plan ? plan : '火山方舟（按量）',
      currency: 'CNY',
      renewalDate: renewal ? String(renewal).slice(0, 10) : undefined,
      unknownFields: renewal === undefined ? ['price', 'renewalDate', 'autoRenew'] : ['price', 'autoRenew'],
    }
  } else {
    res.plan = { name: '火山方舟', currency: 'CNY', unknownFields: ['price', 'renewalDate', 'autoRenew'] }
    notes.push(`GetConsoleUser 未取得（HTTP ${user.status}）：${user.text.slice(0, 140)}`)
  }

  // 流量采集：打开用量跟踪页，把真实 API 请求写进日志（下一轮按此精调）
  const traffic = captureApiTraffic(page)
  await page.goto(USAGE_PAGE, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(6000)
  const paths = traffic.list()
  traffic.stop()
  if (paths.length) {
    notes.push(`用量页流量样本（据此补全采集）：${paths.slice(0, 8).join(' | ')}`)
  } else {
    notes.push('用量页未捕获到 API 请求（页面可能整页刷新或尚未加载完成），下轮再采')
  }
  // 保活页面留在 overview（用量页重交互多，避免长期驻留引发前端轮询风暴）
  await page.goto(CONSOLE_PAGE, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})

  return res
}

// ---------- AK/SK 官方 OpenAPI 数据面 ----------

const RPC = 'https://ark.cn-beijing.volcengineapi.com/'
const RPC_VERSION = '2024-01-01'

// 火山 RPC 签名与阿里云同款（HMAC-SHA1 over 排序后的查询串）
function pct(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

async function volcRpc<T>(akId: string, akSecret: string, action: string, body: unknown): Promise<T> {
  const params: Record<string, string> = {
    Action: action,
    Version: RPC_VERSION,
    AccessKeyId: akId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Format: 'JSON',
  }
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join('&')
  const signature = createHmac('sha1', akSecret).update(`POST\n/\n${qs}`, 'utf8').digest('base64')
  const env = await fetchJson<{ ResponseMetadata?: { Error?: { Code?: string; Message?: string } }; Result?: T }>(
    `${RPC}?${qs}&Signature=${pct(signature)}`,
    { method: 'POST', body }
  )
  const err = env?.ResponseMetadata?.Error
  if (err) throw new PluginError('network', `火山 OpenAPI ${action} 失败：${err.Code} ${err.Message}`)
  return (env?.Result ?? null) as T | null
}

interface InferenceUsageResult {
  Fields?: Array<{ Name?: string; Type?: string }>
  Data?: string[][]
  DataCount?: number
}

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// BillingStatus → 计费平面：normal=按量后付费；free_for_*（模型单元/安心体验/TPM包）
// 与 no_need_billing 都属于订阅/赠送覆盖，归 subscription 平面
function billingPlane(status: string | undefined): 'subscription' | 'payg' {
  return status === 'normal' ? 'payg' : 'subscription'
}

async function fetchViaAksk(ctx: PluginContext, akId: string, akSecret: string): Promise<PluginFetchResult> {
  const now = new Date()
  const start = new Date(now)
  start.setDate(start.getDate() - 29)
  const notes: string[] = []

  // Filters 传 Values:[] 的空过滤 = 把该列加进返回但不过滤（官方文档明示），一次拿全三个维度
  const result = await volcRpc<InferenceUsageResult>(akId, akSecret, 'GetInferenceUsage', {
    StartTime: dayStr(start),
    EndTime: dayStr(now),
    QueryInterval: 'Day',
    Filters: [
      { Key: 'BillingStatus', Values: [] },
      { Key: 'ModelName', Values: [] },
    ],
  })
  if (!result?.Fields?.length || !result.Data?.length) {
    notes.push('GetInferenceUsage 返回空（近29天无用量，或列定义缺失）')
  }

  const fields = (result?.Fields ?? []).map((f) => f.Name ?? '')
  const col = (name: string) => fields.indexOf(name)
  const iDay = col('Day')
  const iIn = col('InputTokens')
  const iOut = col('OutputTokens')
  const iReq = col('ReqCnt')
  const iBilling = col('BillingStatus')
  const iModel = col('ModelName')
  const iAcct = col('AccountID')

  // 日×计费平面：usage_daily 主键含 plan_name，按量/订阅分挂两个计划名才能同日并存
  const dayPlane = new Map<string, { date: string; plan: string; billing: 'subscription' | 'payg'; input: number; output: number; req: number }>()
  const modelMap = new Map<string, PluginModelUsage & { input: number; output: number }>()
  const byStatus = new Map<string, { tokens: number; req: number }>()
  let accountId = ''
  const usage: PluginUsageDay[] = []

  for (const row of result?.Data ?? []) {
    const date = row[iDay] ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const input = num(row[iIn]) ?? 0
    const output = num(row[iOut]) ?? 0
    const req = num(row[iReq]) ?? 0
    const status = iBilling >= 0 ? row[iBilling] : undefined
    const plane = billingPlane(status)
    if (!accountId && iAcct >= 0 && row[iAcct]) accountId = row[iAcct]

    const st = byStatus.get(status ?? '未知') ?? { tokens: 0, req: 0 }
    st.tokens += input + output
    st.req += req
    byStatus.set(status ?? '未知', st)

    const dkey = `${date}|${plane}`
    const d = dayPlane.get(dkey) ?? { date, plan: plane === 'subscription' ? '火山方舟套餐' : '按量付费', billing: plane, input: 0, output: 0, req: 0 }
    d.input += input
    d.output += output
    d.req += req
    dayPlane.set(dkey, d)

    const model = iModel >= 0 ? row[iModel] : ''
    if (model) {
      const mkey = `${date}|${model}`
      const m = modelMap.get(mkey) ?? { date, modelId: model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, input: 0, output: 0 }
      m.inputTokens = (m.inputTokens ?? 0) + input
      m.outputTokens = (m.outputTokens ?? 0) + output
      m.requests = (m.requests ?? 0) + req
      // 模型表主键无计划列：同日同模型两平面混合时不标单一平面
      if (m.billing !== undefined && m.billing !== plane) m.billing = undefined
      else m.billing = plane
      modelMap.set(mkey, m)
    }
  }

  for (const d of dayPlane.values()) {
    usage.push({
      date: d.date,
      inputTokens: d.input,
      outputTokens: d.output,
      cachedTokens: 0,
      requests: d.req,
      costAmount: 0,
      currency: 'CNY',
      planName: d.plan,
      billing: d.billing,
    })
  }
  usage.sort((a, b) => a.date.localeCompare(b.date))

  const models: PluginModelUsage[] = [...modelMap.values()].map((m) => ({
    date: m.date,
    modelId: m.modelId,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cachedTokens: m.cachedTokens,
    requests: m.requests,
    billing: m.billing,
  }))

  const dates = usage.map((u) => u.date).sort()
  const res: PluginFetchResult = { notes }
  if (dates.length) {
    res.usageDaily = usage
    res.modelUsage = models
    res.usageWindow = { from: dates[0], to: dates.at(-1)! }
    res.modelUsageWindow = { from: dates[0], to: dates.at(-1)! }
  }
  res.account = {
    userName: '火山账号',
    maskedContact: accountId ? `account ${accountId.slice(0, 6)}***` : '',
    region: 'CN',
  }
  res.plan = { name: '火山方舟（按量）', currency: 'CNY', unknownFields: ['price', 'renewalDate', 'autoRenew'] }

  const statusDesc = [...byStatus.entries()].map(([k, v]) => `${k}: ${v.tokens.toLocaleString('en-US')} tokens/${v.req} 次`).join('，')
  notes.push(`官方 GetInferenceUsage 回填 ${dates.length} 天（近 29 天，按天粒度，AK/SK 签名）：${statusDesc || '无数据'}`)
  if (modelMap.size) {
    const top = [...modelMap.values()].sort((a, b) => (b.inputTokens ?? 0) + (b.outputTokens ?? 0) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0))).slice(0, 3)
    notes.push(`模型 Top：${top.map((m) => `${m.modelId} ${(((m.inputTokens ?? 0) + (m.outputTokens ?? 0)) / 1e6).toFixed(1)}M`).join('、')}`)
  }
  notes.push('余额/套餐续费信息暂无官方 OpenAPI（AgentPlan 套餐明细可经 GetUsageDetails 补充，下轮接入）')
  ctx.log(`AK/SK 采集完成：${dates.length} 天，${modelMap.size} 行模型明细`)
  return res
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

export const volcenginePlugin: ProviderPlugin = {
  id: 'volcengine',
  displayName: '火山引擎',
  icon: '/icons/volcengine.svg',
  authMethods: ['aksk', 'browser-login'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://www.volcengine.com',
  consoleUrl: CONSOLE_PAGE,

  async login(ctx: PluginContext) {
    return runInteractiveLogin({
      providerId: ctx.providerId,
      dataDir: ctx.dataDir,
      consoleUrl: CONSOLE_PAGE,
      log: ctx.log,
      probe: async (page) => {
        const r = await fetchInPageJson(page, `/ark/bff/api/${REGION}/2024-01-29/GetConsoleUser`, { method: 'POST', body: {} })
        if (r.status === 200 && r.data && typeof r.data === 'object') return { ok: true, desc: 'OK' }
        return { ok: false, desc: `HTTP ${r.status} ${(r.text || '').slice(0, 60)}` }
      },
    })
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'aksk') {
      // 凭证以 "AccessKeyId|AccessKeySecret" 存储（更新凭证弹窗 AK/SK 模式）
      const [akId, akSecret] = (cred.cookie ?? '').split('|').map((s) => s.trim())
      if (!akId || !akSecret) {
        throw new PluginError('not_configured', 'AK/SK 格式应为 AccessKeyId|AccessKeySecret（竖线分隔）')
      }
      return fetchViaAksk(ctx, akId, akSecret)
    }
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      return fetchViaBrowser(ctx)
    }
    throw new PluginError('not_configured', '火山引擎支持 AK/SK（推荐，官方 OpenAPI 全量用量）或浏览器登录')
  },
}
