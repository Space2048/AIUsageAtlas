import { fetchJson } from '~~/server/utils/http'
import { isLoggedIn, markLoggedIn } from '~~/server/utils/browser-profile'
import { closeSession, ensureLivePage, isPageAlive, launchLoginWindow, persistStorageState, snapshotSession, startKeepAlive } from '~~/server/utils/browser-session'
import {
  PluginError,
  type PluginContext,
  type PluginFetchResult,
  type PluginModelUsage,
  type PluginUsageDay,
  type ProviderPlugin,
} from './types'

/**
 * DeepSeek 插件
 *
 * api.deepseek.com（API Key 可读，2026-10-21 核对 api-docs.deepseek.com）：
 * · GET /user/balance —— 余额（整币种单位字符串，非分）
 * · GET /models       —— 模型列表
 * 没有按日用量/配额接口；社区流传的 /v1/dashboard/billing/* 实测（有效 Key）404，勿复活。
 * DeepSeek 的鉴权过滤器在路由之前，任意路径配无效 Key 都返回 401，
 * 所以「探活返回 401」不能证明路径存在，路径只能以官方文档为准。
 *
 * platform.deepseek.com 控制台（2026-10-21 从前端 chunk 逆向 + 实测）：需要**平台会话**
 * （Bearer Key 被拒 code:40003），是浏览器登录模式的数据面：
 * · GET /api/v0/usage/by_api_key/amount?start=&end=&tz=  —— 按模型用量时序。
 *    data.biz_data.series[]：{model, api_key, buckets:[{time(秒), usage:{
 *      PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN, RESPONSE_TOKEN, REQUEST}}]}；
 *    30 天内单次可取（服务端自定 bucket 粒度，天粒度）。tz 传 28800 对齐自然日。
 * · GET /api/v0/usage/by_api_key/cost?start=&end=&tz=   —— 同结构，buckets[].cost 为
 *    十进制字符串金额（真实消费，替代余额差分）。
 * · GET /api/v0/users/get_user_summary                   —— 总/本月用量、钱包、累计消费（notes）。
 * 失败信封 {code:40002 Missing Token | 40003 invalid token, data:null}。
 */

const API_BASE = 'https://api.deepseek.com'

interface BalanceInfo {
  currency?: string
  total_balance?: string | number
  granted_balance?: string | number
  topped_up_balance?: string | number
}

interface BalanceResponse {
  is_available?: boolean
  balance_infos?: BalanceInfo[]
}

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>
}

function money(v: string | number | undefined): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  const headers = { Authorization: `Bearer ${apiKey}` }

  let balance: BalanceResponse
  try {
    balance = await fetchJson<BalanceResponse>(`${API_BASE}/user/balance`, { headers })
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
    }
    if (err.status === 404) {
      throw new PluginError('endpoint_changed', `余额接口路径已变更（HTTP 404）：${API_BASE}/user/balance`)
    }
    throw new PluginError('network', `余额接口请求失败：${err.message}`)
  }

  // 官方文档明确这些值是「整币种单位」的字符串（如 "110.00"），不是分
  const infos = balance.balance_infos ?? []
  // 官方按币种分条返回，跨币种相加会得到一个无意义的数字，所以按币种归组、只取主币种
  const byCur = new Map<string, { total: number; granted: number; toppedUp: number }>()
  for (const i of infos) {
    const cur = i.currency ?? 'USD'
    const acc = byCur.get(cur) ?? { total: 0, granted: 0, toppedUp: 0 }
    acc.total += money(i.total_balance) ?? 0
    acc.granted += money(i.granted_balance) ?? 0
    acc.toppedUp += money(i.topped_up_balance) ?? 0
    byCur.set(cur, acc)
  }
  const currency = infos[0]?.currency ?? 'USD'
  const main = byCur.get(currency) ?? { total: 0, granted: 0, toppedUp: 0 }
  const total = main.total

  let models: ModelsResponse | null = null
  try {
    models = await fetchJson<ModelsResponse>(`${API_BASE}/models`, { headers })
  } catch (e) {
    ctx.log(`模型列表获取失败：${(e as Error).message}`)
  }

  const notes: string[] = []
  if (!infos.length) notes.push('余额接口未返回 balance_infos，账户可能未开通计费')
  if (byCur.size > 1) {
    notes.push(`账户有多个币种的余额：${[...byCur].map(([c, v]) => `${c} ${v.total}`).join('、')}，卡片只显示主币种 ${currency}`)
  }
  if (infos.length) {
    notes.push(`余额构成（${currency}）：合计 ${main.total.toFixed(2)} = 赠送 ${main.granted.toFixed(2)} + 充值 ${main.toppedUp.toFixed(2)}（赠送部分会过期）`)
  }
  if (balance.is_available === false) notes.push('账户当前不可用（is_available=false），可能欠费或被限制')
  notes.push('官方无用量接口：Token 消耗与费用需由调用方累计 chat/completions 响应里的 usage，本平台无法回填历史')
  notes.push('官方无配额窗口接口：限制是账号级并发数（见文档 rate-limit），超并发返回 429 而非额度百分比')

  const list = models?.data ?? []
  if (list.length) {
    notes.push(`可用模型 ${list.length} 个：${list.map((m) => m.id).filter(Boolean).join('、')}`)
  }

  ctx.log(`余额 ${total} ${currency}，模型 ${list.length} 个`)

  return {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`,
      region: 'CN',
    },
    plan: { name: '按量付费', currency },
    balance: infos.length ? { amount: total, currency } : undefined,
    // 模型接口请求失败时 models 为 null：不下发该字段，保留库里上一次的列表
    availableModels: models ? list.map((m) => m.id).filter((x): x is string => !!x) : undefined,
    notes,
  }
}

// ---------- 控制台会话数据面（浏览器登录模式） ----------

const CONSOLE = 'https://platform.deepseek.com'
const CONSOLE_PAGE = `${CONSOLE}/`
const LOGIN_URL = /(passport|account\.|\/auth\/|\/login|signin|sign-?up)/i
// 控制台默认中国时区：bucket 时间(秒) + tz 对齐到自然日
const TZ_SEC = 28_800
const USAGE_RANGE_DAYS = 30

type JsonGet = <T>(url: string) => Promise<T>

interface ChartBucket {
  time?: number
  cost?: number | string
  usage?: Record<string, number | string>
}
interface ChartSeries {
  model?: string
  buckets?: ChartBucket[]
}
interface ChartBiz {
  bucket?: number
  start?: number
  end?: number
  series?: ChartSeries[]
  functionSeries?: ChartSeries[]
  // cost 接口的一种嵌套变体（data[0].series），解析时两种都试
  data?: Array<{ currency?: string; series?: ChartSeries[]; functionSeries?: ChartSeries[] }>
}

// DeepSeek 控制台鉴权 = localStorage.userToken（appKit 包装 {"value":"<jwt>","__version":0}）
// 注入 Authorization: Bearer —— 裸 fetch 只会拿 40002/40003（实测），探测与采集都必须带头。
// 另外必须带 SPA 同款 x-client-* 头（2026-10-21 对照实测：缺头时即便参数正确也回
// INVALID_PARAM，头齐全后与页面原生请求一致返回 biz_code 0）
const TOKEN_LS_KEY = 'userToken'
const DEVICE_LS_KEY = 'deepseek-device-id:platform'

async function fetchInPage<T>(page: import('playwright').Page, url: string): Promise<T> {
  const call = page.evaluate(
    async ([u, tokenKey, devKey]) => {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'x-client-locale': 'zh_CN',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-client-version': '1.0.0',
        'x-client-platform': 'web',
        'x-client-timezone-offset': '28800',
        'x-device-model': '',
      }
      try {
        const raw = localStorage.getItem(tokenKey as string)
        const j = raw ? JSON.parse(raw) : null
        const tok = j && typeof j.value === 'string' ? j.value : ''
        if (tok) headers['Authorization'] = `Bearer ${tok}`
      } catch {
        /* 无 token：下面的请求会拿 40002，由调用方按状态处理 */
      }
      try {
        const rawDev = localStorage.getItem(devKey as string)
        const jd = rawDev ? JSON.parse(rawDev) : null
        const dev = jd && typeof jd.value === 'string' ? jd.value : ''
        if (dev) headers['x-device-id'] = dev
      } catch {
        /* 设备号可选 */
      }
      const res = await fetch(u as string, { credentials: 'include', headers })
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
    },
    [url, TOKEN_LS_KEY, DEVICE_LS_KEY] as [string, string, string]
  ) as Promise<T>
  return Promise.race([call, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`请求超时（${url}）`)), 30_000))])
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function bucketDay(time: number | undefined): string {
  if (time === undefined || !Number.isFinite(time) || time <= 0) return ''
  return new Date((time + TZ_SEC) * 1000).toISOString().slice(0, 10)
}

// 会话接口信封：失败 {code:40002/40003, data:null}；成功 {data:{biz_data}}（部分接口 data 直接给结构）
async function consoleBiz(get: JsonGet, path: string): Promise<{ biz: ChartBiz | null; authFailed: boolean; sample: string }> {
  try {
    const res = await get<{ code?: number; msg?: string; data?: unknown }>(`${CONSOLE}${path}`)
    if (res?.code === 40002 || res?.code === 40003) return { biz: null, authFailed: true, sample: '' }
    const d = res?.data
    const biz =
      d && typeof d === 'object' && 'biz_data' in (d as object)
        ? (((d as { biz_data?: ChartBiz }).biz_data ?? null) as ChartBiz | null)
        : ((d as ChartBiz) ?? null)
    return { biz, authFailed: false, sample: JSON.stringify(biz ?? d ?? res).slice(0, 300) }
  } catch (e) {
    const s = (e as { status?: number }).status
    return { biz: null, authFailed: s === 401 || s === 403, sample: '' }
  }
}

function usageQuery(): string {
  // 与控制台原生请求完全一致（2026-10-21 抓包对照）：本地午夜对齐，
  // end = 本地明日 0 点，跨度固定 30 天；非对齐的任意秒级区间会被判 INVALID_PARAM
  const tzMs = TZ_SEC * 1000
  const endMs = Math.floor((Date.now() + tzMs) / 86_400_000) * 86_400_000 - tzMs + 86_400_000
  const startMs = endMs - USAGE_RANGE_DAYS * 86_400_000
  return `?start=${startMs / 1000}&end=${endMs / 1000}&tz=${TZ_SEC}`
}

/** 控制台按日×模型用量 + 真实费用；会话失效抛 auth_expired */
async function fetchConsoleUsage(get: JsonGet, notes: string[]): Promise<{
  usage: PluginUsageDay[]
  models: PluginModelUsage[]
  window: { from: string; to: string }
  totalTokens: number
} | null> {
  const amt = await consoleBiz(get, `/api/v0/usage/by_api_key/amount${usageQuery()}`)
  if (amt.authFailed) {
    throw new PluginError('auth_expired', '控制台会话已失效（code 40002/40003），请重新浏览器登录')
  }
  if (!amt.biz?.series?.length) {
    notes.push(`控制台用量未取得（amount ${amt.biz ? 'series 为空' : '无响应'}），保留上次数据${amt.sample ? `；样例：${amt.sample}` : ''}`)
    return null
  }

  // cost 单独取：失败只影响费用（退回余额差分），不影响 token
  let costByDay: Map<string, number> | null = null
  const cost = await consoleBiz(get, `/api/v0/usage/by_api_key/cost${usageQuery()}`)
  if (cost.biz) {
    const items = cost.biz.series ?? cost.biz.data?.[0]?.series ?? []
    costByDay = new Map()
    for (const it of items) {
      for (const b of it.buckets ?? []) {
        const day = bucketDay(b.time)
        const v = num(b.cost) ?? num(b.usage?.COST)
        if (day && v !== undefined) costByDay.set(day, (costByDay.get(day) ?? 0) + v)
      }
    }
    notes.push(`控制台费用已取（${costByDay.size} 天），当日费用不再走余额差分`)
  } else {
    notes.push(`控制台费用未取得（cost ${cost.authFailed ? '会话失效' : '无响应'}），费用退回余额差分推算`)
  }

  const dayMap = new Map<string, { hit: number; miss: number; out: number; req: number }>()
  const modelMap = new Map<string, PluginModelUsage>()
  let totalTokens = 0
  for (const it of amt.biz.series) {
    const model = it.model || 'unknown'
    for (const b of it.buckets ?? []) {
      const day = bucketDay(b.time)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const hit = num(b.usage?.PROMPT_CACHE_HIT_TOKEN) ?? 0
      const miss = num(b.usage?.PROMPT_CACHE_MISS_TOKEN) ?? 0
      const out = num(b.usage?.RESPONSE_TOKEN) ?? 0
      const req = num(b.usage?.REQUEST) ?? 0
      totalTokens += hit + miss + out
      const d = dayMap.get(day) ?? { hit: 0, miss: 0, out: 0, req: 0 }
      d.hit += hit
      d.miss += miss
      d.out += out
      d.req += req
      dayMap.set(day, d)
      const key = `${day}|${model}`
      const m = modelMap.get(key) ?? { date: day, modelId: model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, billing: 'payg' }
      m.inputTokens = (m.inputTokens ?? 0) + miss
      m.cachedTokens = (m.cachedTokens ?? 0) + hit
      m.outputTokens = (m.outputTokens ?? 0) + out
      m.requests = (m.requests ?? 0) + req
      modelMap.set(key, m)
    }
  }
  const dates = [...dayMap.keys()].sort()
  if (!dates.length) {
    notes.push(`控制台用量解析为空（样例：${amt.sample}）`)
    return null
  }

  const usage: PluginUsageDay[] = dates.map((day) => {
    const d = dayMap.get(day)!
    return {
      date: day,
      inputTokens: d.miss,
      cachedTokens: d.hit,
      outputTokens: d.out,
      requests: d.req,
      costAmount: Number((costByDay?.get(day) ?? 0).toFixed(6)),
      currency: 'CNY',
      billing: 'payg' as const,
    }
  })
  notes.push(
    `控制台用量回填 ${usage.length} 天 / ${modelMap.size} 行模型明细（近 ${USAGE_RANGE_DAYS} 天 by_api_key/amount，合计 ${totalTokens.toLocaleString('en-US')} tokens${costByDay ? `，费用覆盖 ${costByDay.size} 天` : ''}）`
  )
  return { usage, models: [...modelMap.values()], window: { from: dates[0], to: dates.at(-1)! }, totalTokens }
}

// 总用量/钱包/累计消费 → 仅 notes（余额真值仍以 /user/balance 为准）
async function noteUserSummary(get: JsonGet, notes: string[]) {
  const probe = await consoleBiz(get, '/api/v0/users/get_user_summary')
  if (!probe.biz) return
  const b = probe.biz as unknown as Record<string, unknown>
  const total = num(b.total_usage)
  const monthly = num(b.monthly_usage)
  const costs = Array.isArray(b.total_costs)
    ? (b.total_costs as Array<{ currency?: string; amount?: number | string }>).map((c) => `${c.currency} ${c.amount}`).join('、')
    : ''
  const parts: string[] = []
  if (total !== undefined) parts.push(`历史总用量 ${total.toLocaleString('en-US')} tokens`)
  if (monthly !== undefined) parts.push(`本月 ${monthly.toLocaleString('en-US')} tokens`)
  if (costs) parts.push(`累计消费 ${costs}`)
  if (parts.length) notes.push(`控制台概览：${parts.join('；')}`)
}

async function ensureSessionPage(ctx: PluginContext): Promise<import('playwright').Page> {
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

/** Key 采集（余额/模型）之上叠加控制台会话用量；无 Key 时纯会话（余额/模型沿用旧值） */
async function mergeSessionUsage(ctx: PluginContext, result: PluginFetchResult, notes: string[]) {
  const page = await ensureSessionPage(ctx)
  const get: JsonGet = <T,>(url: string): Promise<T> => fetchInPage<T>(page, url)
  await noteUserSummary(get, notes)
  const usage = await fetchConsoleUsage(get, notes)
  if (usage) {
    result.usageDaily = usage.usage
    result.modelUsage = usage.models
    result.modelUsageWindow = usage.window
    result.usageWindow = usage.window
  }
  await snapshotSession(ctx.providerId, ctx.dataDir).catch(() => {})
}

export const deepseekPlugin: ProviderPlugin = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  icon: '/icons/deepseek.svg',
  authMethods: ['apikey', 'browser-login'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://platform.deepseek.com',
  consoleUrl: CONSOLE_PAGE,

  async login(ctx: PluginContext): Promise<{ ok: boolean; message: string }> {
    try {
      await import('playwright')
    } catch {
      throw new PluginError('not_configured', '未安装 playwright：npm i -D playwright && npx playwright install chromium')
    }
    const pw = await import('playwright')
    // 避免保活实例与登录实例同开一个 profile 互冲 Cookie
    await closeSession(ctx.providerId).catch(() => {})
    const context = await launchLoginWindow(pw, ctx.dataDir, ctx.providerId)
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(CONSOLE_PAGE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      ctx.log('已打开 DeepSeek 控制台，等待登录…')

      let closed = false
      context.on('close', () => {
        closed = true
      })
      const deadline = Date.now() + 240_000
      let lastProbe = '尚未探测'
      while (Date.now() < deadline) {
        if (closed) return { ok: false, message: '浏览器窗口已关闭，登录已取消' }
        await page.waitForTimeout(2500).catch(() => {})
        // 探测必须带 userToken 头 + SPA 同款 x-client-* 头（缺头/裸 fetch 都会误判成未登录）
        const probe = await page
          .evaluate(
            async ([q, key]) => {
              let tok = ''
              try {
                const raw = localStorage.getItem(key as string)
                const j = raw ? JSON.parse(raw) : null
                tok = j && typeof j.value === 'string' ? j.value : ''
              } catch {
                /* 无 token */
              }
              if (!tok) return 'LS userToken 为空（尚未登录）'
              try {
                const r = await fetch(q as string, {
                  credentials: 'include',
                  headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${tok}`,
                    'x-client-locale': 'zh_CN',
                    'x-client-bundle-id': 'com.deepseek.chat',
                    'x-client-version': '1.0.0',
                    'x-client-platform': 'web',
                    'x-client-timezone-offset': '28800',
                    'x-device-model': '',
                  },
                })
                const j = await r.json().catch(() => null)
                const d = j && j.data
                const desc = `HTTP ${r.status} code ${j && j.code !== undefined ? j.code : '-'}${
                  d && d.biz_code !== undefined ? ` biz_code ${d.biz_code} ${d.biz_msg || ''}` : ''
                }${j && j.msg ? ` ${j.msg}` : ''}`
                return j && j.code === 0 && d && d.biz_code === 0 ? 'OK' : desc
              } catch (e) {
                return `探测异常：${String(e).slice(0, 80)}`
              }
            },
            [`/api/v0/usage/by_api_key/amount${usageQuery()}`, TOKEN_LS_KEY] as [string, string]
          )
          .catch(() => '探测调用失败')
        lastProbe = probe
        if (probe === 'OK') {
          markLoggedIn(ctx.dataDir, ctx.providerId)
          await persistStorageState(context, ctx.dataDir, ctx.providerId).catch(() => {})
          await context.close().catch(() => {})
          await closeSession(ctx.providerId).catch(() => {})
          await startKeepAlive(ctx.providerId, ctx.dataDir, CONSOLE_PAGE)
          return { ok: true, message: '登录成功，会话已保存并启动保活' }
        }
      }
      return { ok: false, message: `登录超时（4 分钟未检测到会话生效；最近探测：${lastProbe}），请重试` }
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
      // 余额/模型只认 API Key（api.deepseek.com 不认平台会话）：有存 Key 就先取，
      // 会话只负责控制台用量/费用/概览
      const apiCred = ctx.loadCredential?.('apikey')
      if (apiCred?.kind === 'apikey') {
        const result = await fetchViaApiKey(ctx, apiCred.apiKey)
        const notes = result.notes ?? (result.notes = [])
        await mergeSessionUsage(ctx, result, notes)
        return result
      }
      const notes: string[] = []
      const result: PluginFetchResult = { notes }
      await mergeSessionUsage(ctx, result, notes)
      notes.push('未配置 API Key：余额与模型列表沿用上次采集（api.deepseek.com 不认平台会话）')
      return result
    }
    throw new PluginError('not_configured', '凭证类型不支持')
  },
}
