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
  type PluginModelPrice,
  type ProviderPlugin,
} from './types'

/**
 * 阿里通义插件（百炼平台 Model Studio / DashScope，bailian.console.aliyun.com）
 *
 * 2026-10-21 现状：
 * · API Key（DashScope）可读：GET https://dashscope.aliyuncs.com/compatible-mode/v1/models
 *   （OpenAI 兼容风格 {data:[{id}]}）—— 模型列表与探活。
 * · 余额/按日用量/费用在百炼控制台（阿里云账号会话），无公开 Key 接口；
 *   控制台 API 统一挂在 bailian.console.aliyun.com 的网关下（已见 /api/alfa/console/config、
 *   /api/console-base/categories_n_products），用量接口 Action 尚未拿到：
 *   浏览器登录后每次同步用 captureApiTraffic 把真实请求写进日志，据此逐轮补全。
 * 计划字段采不到就标红色「未获取到」，不拿 0/false 冒充。
 */

const DASHSCOPE = 'https://dashscope.aliyuncs.com'
const CONSOLE_PAGE = 'https://bailian.console.aliyun.com/'
const LOGIN_URL = /(passport|login\.aliyun|signin|oauth)/i

interface DashModels {
  data?: Array<{ id?: string }>
}

// 旧版管理接口 /api/v1/models（Bearer Key 可读，2026-10-21 实测）：分页返回完整模型库，
// 每条带 name/description/capabilities 与官方 prices（input_token/output_token/
// input_token_cache，单位「每百万tokens」，人民币）—— 356 个模型、347 条带价。
interface LegacyModelPriceItem {
  type?: string
  price?: string
}
interface LegacyModel {
  model?: string
  name?: string
  description?: string
  prices?: Array<{ prices?: LegacyModelPriceItem[] }>
}
interface LegacyModelsResp {
  output?: { total?: number; page_no?: number; page_size?: number; models?: LegacyModel[] }
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 分页拉全旧版模型库 → {全部 id, 官方价目}；任一页失败返回 null（保留旧数据） */
async function fetchLegacyModels(apiKey: string): Promise<{ ids: string[]; prices: PluginModelPrice[]; total: number } | null> {
  const all: LegacyModel[] = []
  let total = 0
  for (let page = 1; page <= 5; page++) {
    let resp: LegacyModelsResp
    try {
      resp = await fetchJson<LegacyModelsResp>(`${DASHSCOPE}/api/v1/models?page_no=${page}&page_size=100`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    } catch {
      return page > 1 && all.length ? finish(all, total) : null
    }
    const models = resp.output?.models ?? []
    if (resp.output?.total) total = resp.output.total
    if (!models.length) break
    all.push(...models)
    if (all.length >= (total || 0)) break
  }
  return all.length ? finish(all, total) : null
}

function finish(all: LegacyModel[], total: number) {
  const ids = all.map((m) => m.model).filter((x): x is string => !!x)
  const prices: PluginModelPrice[] = []
  for (const m of all) {
    if (!m.model) continue
    const bucket = m.prices?.[0]?.prices
    if (!Array.isArray(bucket)) continue
    let input: number | undefined
    let output: number | undefined
    let cached: number | undefined
    for (const p of bucket) {
      // 标准文本与 omni 系列（音频/文本混合模型的主输入输出）都映射到 token 价；
      // video_ratio_*/按次计费等特殊类型不映射，宁可页面显示 —— 也不编造单价
      if (p.type === 'input_token' || p.type === 'omni_input_token') input = num(p.price)
      else if (p.type === 'output_token' || p.type === 'omni_output_token') output = num(p.price)
      else if (p.type === 'input_token_cache' || p.type === 'omni_input_token_cache') cached = num(p.price)
    }
    if (input === undefined && output === undefined) continue
    prices.push({ modelId: m.model, currency: 'CNY', inputPerM: input ?? 0, outputPerM: output ?? 0, cachedReadPerM: cached ?? 0 })
  }
  return { ids, prices, total }
}

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

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  let models: DashModels
  try {
    models = await fetchJson<DashModels>(`${DASHSCOPE}/compatible-mode/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
    }
    throw new PluginError('network', `模型列表请求失败：${err.message}`)
  }
  const list = (models.data ?? []).map((m) => m.id).filter((x): x is string => !!x)
  if (!list.length) throw new PluginError('parse', '模型列表为空，Key 可能没有可用模型权限')

  // 旧版管理接口是超集数据面：全量模型库 + 官方价目；失败不阻塞（保留已有列表与价格）
  const legacy = await fetchLegacyModels(apiKey)

  const notes: string[] = []
  if (legacy) {
    const ids = [...new Set([...legacy.ids, ...list])]
    notes.push(
      `模型库合计 ${ids.length} 个（兼容模式 ${list.length} + 管理接口 ${legacy.ids.length} 去重），官方价目 ${legacy.prices.length} 条已入库（CNY / 百万tokens）`
    )
    ctx.log(`Key 可用，模型 ${ids.length} 个，价目 ${legacy.prices.length} 条`)
    notes.push('余额/按日用量/费用在百炼控制台页面（API Key 无接口），已做浏览器登录后同步会自动补采')
    return {
      account: {
        userName: 'API 用户',
        maskedContact: `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`,
        region: 'CN',
      },
      plan: { name: '按量付费', currency: 'CNY', unknownFields: ['price', 'renewalDate', 'autoRenew'] },
      availableModels: ids,
      modelPrices: legacy.prices,
      notes,
    }
  }
  notes.push(`Key 可用，DashScope 兼容模式可见模型 ${list.length} 个：${list.slice(0, 8).join('、')}${list.length > 8 ? ' …' : ''}`)
  notes.push('旧版模型库接口未取得（/api/v1/models），价目未更新')
  notes.push('余额/按日用量/费用在百炼控制台页面（API Key 无接口），已做浏览器登录后同步会自动补采')
  ctx.log(`Key 可用，模型 ${list.length} 个`)

  return {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`,
      region: 'CN',
    },
    plan: { name: '按量付费', currency: 'CNY', unknownFields: ['price', 'renewalDate', 'autoRenew'] },
    availableModels: list,
    notes,
  }
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

  res.plan = { name: '按量付费（百炼）', currency: 'CNY', unknownFields: ['price', 'renewalDate', 'autoRenew'] }
  res.account = { userName: '阿里云用户', maskedContact: '', region: 'CN' }

  // 直接抓两个「登录后才有」的实证端点（2026-10-21 无登录探测确认存在）：
  // /data/api.json = 控制台 API 清单（若返回 JSON 路由表，下一轮据此精确实现采集）
  const info = await fetchInPageJson(page, '/tool/user/info.json')
  if (info.status === 200 && info.data && typeof info.data === 'object') {
    const email = String(deepFind(info.data, ['email', 'mail', 'Email']) ?? '')
    const name = String(deepFind(info.data, ['nickName', 'nickname', 'name', 'UserName']) ?? '')
    if (name || email) {
      res.account = {
        userName: name || '阿里云用户',
        maskedContact: email ? email.replace(/^(.).*?(@.*)$/s, '$1***$2') : '',
        region: 'CN',
      }
      notes.push(`账号：${name || '-'}${email ? ` / ${email.slice(0, 3)}***${email.slice(-6)}` : ''}`)
    }
  } else {
    notes.push(`/tool/user/info.json：${info.status} ${info.text.slice(0, 100)}`)
  }

  const apiCfg = await fetchInPageJson(page, '/data/api.json')
  if (apiCfg.status === 200 && apiCfg.data) {
    const s = JSON.stringify(apiCfg.data)
    notes.push(`/data/api.json 已取得（${s.length} 字节）：${s.slice(0, 300)}`)
  } else {
    notes.push(`/data/api.json：${apiCfg.status} ${apiCfg.text.slice(0, 80)}`)
  }

  // 流量采集：依次打开费用概览与模型用量页，把真实 API 写进日志（据此补全采集）
  const traffic = captureApiTraffic(page)
  for (const route of ['/costing-balance', '/costing-balance/usage-statistics']) {
    await page.goto(`https://bailian.console.aliyun.com${route}`, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
    await page.waitForTimeout(7000)
  }
  const paths = traffic.list()
  traffic.stop()
  notes.push(
    paths.length
      ? `控制台流量样本（据此补全采集）：${paths.slice(0, 15).join(' | ')}`
      : '控制台未捕获到 API 请求（页面可能未完成加载），下轮再采'
  )

  return res
}

export const tongyiPlugin: ProviderPlugin = {
  id: 'tongyi',
  displayName: '阿里通义',
  icon: '/icons/tongyi.svg',
  authMethods: ['apikey', 'browser-login'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://bailian.console.aliyun.com',
  consoleUrl: CONSOLE_PAGE,

  async login(ctx: PluginContext) {
    return runInteractiveLogin({
      providerId: ctx.providerId,
      dataDir: ctx.dataDir,
      consoleUrl: CONSOLE_PAGE,
      log: ctx.log,
      probe: async (page) => {
        // 阿里云登录会话 Cookie（havana/login_aliyun 系）落地即视为成功
        const cookies = await page.context().cookies().catch(() => [])
        const hasSession = cookies.some((c) => /login_aliyun|havana|sessionid|_aop_|token/i.test(c.name))
        const onLoginRoute = /passport|login\.aliyun|signin/i.test(page.url())
        if (hasSession && !onLoginRoute) return { ok: true, desc: 'OK（检测到会话 Cookie）' }
        return { ok: false, desc: `url=${page.url().slice(0, 60)} cookies=${cookies.map((c) => c.name).filter((n) => /login|havana|session|token/i.test(n)).join(',') || '无'}` }
      },
    })
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'apikey') return fetchViaApiKey(ctx, cred.apiKey)
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      return fetchViaBrowser(ctx)
    }
    throw new PluginError('not_configured', '凭证类型不支持')
  },
}
