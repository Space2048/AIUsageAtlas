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
import { PluginError, type PluginContext, type PluginFetchResult, type ProviderPlugin } from './types'

/**
 * Qoder 插件（阿里 Qoder 智能编程 IDE，qoder.com）
 *
 * 2026-10-21 前端 chunk 逆向 + 无登录实测：
 * · 平台是 Next.js 应用，控制台 API = https://qoder.com/api/v1/*（REST + 会话 Cookie）
 * · GET /api/v1/me                    —— 账号信息（未登录 401）
 * · GET /api/v1/me/userplan           —— 用户套餐/额度（结构未见响应体，按语义键名容错解析，
 *                                        解析不出就保持红色「未获取到」并在日志留样例）
 * · GET /api/v1/organizations/        —— 组织
 * 没有公开的 API Key 数据面（IDE 订阅型产品），凭证只有浏览器登录；
 * 其余用量接口尚未暴露：每次同步用 captureApiTraffic 把控制台真实请求写进日志，据此逐轮补全。
 */

const CONSOLE_PAGE = 'https://qoder.cn/'
const EP = {
  me: '/api/v1/me',
  userplan: '/api/v1/me/userplan',
}

// 国内站与全球版是两个独立域名（2026-10-22 实测）：
// · qoder.cn —— 研发编程助手（阿里账号，人民币），/api/v1/me 同款接口（未登录 401）
// · qoder.com/zh —— 国际版落地页（页面上有「访问中国站 → qoder.cn」入口），美元
// 早期误把 qoder.com/zh 当国内站：它渲染的是国际站内容，登录窗口会"跑到国际版"。
const QODER_SITES = [
  { id: 'cn', label: '国内站（阿里账号 · CNY）', consoleUrl: 'https://qoder.cn/', currency: 'CNY' },
  { id: 'global', label: '全球版（国际账号 · USD）', consoleUrl: 'https://qoder.com/zh', currency: 'USD' },
]

function siteOf(ctx: PluginContext): { consoleUrl: string; currency: string } {
  const url = ctx.consoleUrl || QODER_SITES[0].consoleUrl
  return { consoleUrl: url, currency: QODER_SITES.find((s) => s.consoleUrl === url)?.currency ?? 'CNY' }
}

function siteJoin(base: string, route: string): string {
  const b = base.endsWith('/') ? base : `${base}/`
  return new URL(route.replace(/^\//, ''), b).href
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

function maskEmail(email: string): string {
  return email.replace(/^(.).*?(@.*)$/s, '$1***$2')
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

// 毫秒/秒时间戳或日期串 → YYYY-MM-DD
function isoOf(v: unknown): string | null {
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
  const n = num(v)
  if (n === undefined || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(0, 10)
}

async function ensureSession(ctx: PluginContext): Promise<import('playwright').Page> {
  const base = siteOf(ctx).consoleUrl
  const fresh = !isPageAlive(ctx.providerId)
  let page = await ensureLivePage(ctx.providerId, ctx.dataDir, base)
  if (fresh) await page.waitForTimeout(2000)
  if (/(passport|login|signin|oauth|sign-?up)/i.test(page.url())) {
    await closeSession(ctx.providerId).catch(() => {})
    page = await ensureLivePage(ctx.providerId, ctx.dataDir, base)
    if (/(passport|login|signin|oauth|sign-?up)/i.test(page.url())) {
      throw new PluginError('auth_expired', '浏览器会话已过期，请重新浏览器登录（详情页 → 更新凭证 → 浏览器登录）')
    }
  }
  return page
}

async function fetchViaBrowser(ctx: PluginContext): Promise<PluginFetchResult> {
  const page = await ensureSession(ctx)
  const notes: string[] = []
  const res: PluginFetchResult = { notes }

  // 账号
  const me = await fetchInPageJson(page, `${EP.me}`)
  if (me.status === 401 || me.status === 403) {
    throw new PluginError('auth_expired', `控制台会话已失效（HTTP ${me.status}），请重新浏览器登录`)
  }
  if (me.status === 200 && me.data && typeof me.data === 'object') {
    const email = String(deepFind(me.data, ['email', 'mail']) ?? '')
    const name = String(deepFind(me.data, ['name', 'nickname', 'username']) ?? '')
    res.account = {
      userName: name || 'Qoder 用户',
      maskedContact: email ? maskEmail(email) : '',
      region: 'CN',
    }
    notes.push(`账号：${name || '(无用户名)'}${email ? ` / ${maskEmail(email)}` : ''}`)
  } else {
    notes.push(`/me 未取得（HTTP ${me.status}）：${me.text.slice(0, 120)}`)
  }

  // 套餐/额度：语义键名容错；解析不出就标未获取到，绝不编数字
  const up = await fetchInPageJson(page, `${EP.userplan}`)
  if (up.status === 200 && up.data) {
    // 实测完整结构（qoder.cn /me/userplan）：plan_tier_name、end_date(毫秒)、
    // amount_paid+currency、auto_renew、billing_cycle —— 三个计划字段全部有据可填；
    // credits 类额度字段未出现（试用套餐），配额窗口暂不建
    const name = deepFind(up.data, ['plan_tier_name', 'plan_tier', 'plan_name', 'planName', 'plan', 'name'])
    const renewal = isoOf(deepFind(up.data, ['end_date', 'next_refresh_date', 'expires_at', 'renewal_date', 'renewalDate']))
    const paid = num(deepFind(up.data, ['amount_paid', 'amountPaid', 'price']))
    const auto = deepFind(up.data, ['auto_renew', 'autoRenew'])
    const cycle = deepFind(up.data, ['billing_cycle'])
    const cur = String(deepFind(up.data, ['currency', 'Currency']) ?? '').toUpperCase()
    const currency = cur === 'USD' ? 'USD' : cur === 'CNY' ? 'CNY' : site.currency
    const unknowns: Array<'price' | 'renewalDate' | 'autoRenew'> = []
    if (paid === undefined) unknowns.push('price')
    if (!renewal) unknowns.push('renewalDate')
    const autoRenew = typeof auto === 'boolean' ? auto : num(auto) !== undefined ? !!num(auto) : undefined
    if (autoRenew === undefined) unknowns.push('autoRenew')
    res.plan = {
      name: typeof name === 'string' && name ? name : 'Qoder',
      currency,
      price: paid,
      renewalDate: renewal ?? undefined,
      autoRenew,
      unknownFields: unknowns,
    }
    notes.push(
      `订阅：${res.plan.name}${cycle ? `（${String(cycle).replace(/^BILLING_CYCLE_/, '')}）` : ''}` +
        `${renewal ? `，有效至 ${renewal}` : ''}${paid !== undefined ? `，已付 ${currency === 'CNY' ? '¥' : '$'}${paid}` : ''}` +
        `${autoRenew !== undefined ? `，自动续费${autoRenew ? '开' : '关'}` : ''}`
    )
    const credits = deepFind(up.data, ['credits', 'credit', 'balance', 'quota', 'remaining'])
    if (credits !== undefined) notes.push(`检测到额度字段：${String(credits).slice(0, 40)}（结构待核对后接入配额窗口）`)
    notes.push(`套餐接口样例：${up.text.slice(0, 300)}`)
  } else {
    res.plan = { name: 'Qoder', currency: site.currency, unknownFields: ['price', 'renewalDate', 'autoRenew'] }
    notes.push(`/userplan 未取得（HTTP ${up.status}）：${up.text.slice(0, 120)}`)
  }

  // 组织信息（如果账号在组织内）
  const org = await fetchInPageJson(page, '/api/v1/organizations/')
  if (org.status === 200 && org.data) {
    notes.push(`组织：${JSON.stringify(org.data).slice(0, 160)}`)
  }

  // 多页面导航 + 双通道采样（按本实例站点）：
  // 1) 客户端 API 流量（若有）→ 接口路径清单
  // 2) 页面可见文本（Next.js 服务端渲染的用量数字可能不走客户端 API）→ 渲染值样例
  const site = siteOf(ctx)
  const traffic = captureApiTraffic(page)
  const textSamples: string[] = []
  // qoder.cn 没有 /plan 路由（实测404），首页即登录后的工作台，单页采样足够
  for (const route of ['/']) {
    await page.goto(siteJoin(site.consoleUrl, route), { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(5000)
    const text = await page
      .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400))
      .catch(() => '')
    if (text) textSamples.push(`${route}: ${text}`)
  }
  const paths = traffic.list()
  traffic.stop()
  if (paths.length) {
    notes.push(`控制台流量样本（据此补全采集）：${paths.slice(0, 8).join(' | ')}`)
  }
  if (textSamples.length) {
    notes.push(`页面文本样例：${textSamples.join(' || ').slice(0, 700)}`)
  }

  return res
}

export const qoderPlugin: ProviderPlugin = {
  id: 'qoder',
  displayName: 'Qoder',
  icon: '/icons/qoder.svg',
  authMethods: ['browser-login'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://qoder.com',
  consoleUrl: CONSOLE_PAGE,
  sites: QODER_SITES,

  async login(ctx: PluginContext) {
    return runInteractiveLogin({
      providerId: ctx.providerId,
      dataDir: ctx.dataDir,
      consoleUrl: ctx.consoleUrl ?? CONSOLE_PAGE,
      log: ctx.log,
      probe: async (page) => {
        const r = await fetchInPageJson(page, `${EP.me}`)
        if (r.status === 200 && r.data) return { ok: true, desc: 'OK' }
        return { ok: false, desc: `HTTP ${r.status} ${r.text.slice(0, 60)}` }
      },
    })
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      const result = await fetchViaBrowser(ctx)
      return result
    }
    throw new PluginError('not_configured', 'Qoder 只支持浏览器登录（无公开 API 数据面）')
  },
}
