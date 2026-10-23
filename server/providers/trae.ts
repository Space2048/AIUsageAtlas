import { isLoggedIn } from '~~/server/utils/browser-profile'
import {
  captureJsonResponses,
  closeSession,
  ensureLivePage,
  isPageAlive,
  runInteractiveLogin,
} from '~~/server/utils/browser-session'
import { PluginError, type PluginContext, type PluginFetchResult, type ProviderPlugin } from './types'

/**
 * Trae 插件（字节跳动 AI IDE，trae.cn）
 *
 * 2026-10-21 实测（登录后真实响应采样）：
 * · 没有任何 API Key 数据面：官方接口只有会话制 RPC。
 * · 关键约束：字节 WAF（SLARDAR/glue）只放行**页面自身发出的请求**，
 *   evaluate 直调 fetch 一律返回挑战页 HTML —— 所以采集用 captureJsonResponses：
 *   由页面加载触发真实请求，再收响应体（不能用 fetchInPageJson）。
 * · 已实测的真实接口（POST，登录后页面自动发起）：
 *   /cloudide/api/v3/trae/CheckLogin     → Result{IsLogin, ExpiredAt(ms), Host...}
 *   /cloudide/api/v3/trae/GetUserInfo    → Result{NickName/头像/LastLoginTime...}
 *   /cloudide/api/v3/common/GetUserToken → Result{ExpiredAt, Token(JWT)}
 *   /trae/api/v2/pay/cn_credits_billing_status → {is_credits_billing, should_force_switch}
 *   /trae/api/v2/pay/user_current_entitlement_list（body {require_usage,full_data}）
 *     → usage_summary{consumed_amount/consumption_ratio/total_amount}（积分用量）
 *       + user_entitlement_pack_list[].display_desc（如「会员 Pro 连续包月」）。
 * · 价格字段（charge_amount 等）单位未证实，保持红色「未获取到」直至确认，不编数字。
 */

const CONSOLE_PAGE = 'https://www.trae.cn/'
const LOGIN_URL = /(passport|login|signin|oauth|sign-?up|account\.bytedance)/i

const KNOWN_ENDPOINTS = [
  'CheckLogin',
  'GetUserInfo',
  'user_current_entitlement_list',
  'cn_credits_billing_status',
]

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

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

// 权益到期时间：毫秒/秒时间戳或日期字符串 → YYYY-MM-DD
function isoOf(v: unknown): string | null {
  if (typeof v === 'string') {
    return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
  }
  const n = num(v)
  if (n === undefined || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(0, 10)
}

function maskContact(s: string): string {
  if (s.includes('@')) return s.replace(/^(.).*?(@.*)$/s, '$1***$2')
  return s.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

/**
 * trae.cn / trae.com.cn 按出口 IP 做区域限制：非中国大陆返回 HTTP 403 +
 * 「抱歉，您当前区域不支持访问」，且 Content-Type 是 application/octet-stream、
 * 无 Content-Disposition —— Chrome 会把这跳导航当成文件下载，Playwright 侧表现为
 * `page.goto: Download is starting`，登录窗口连页面都打不开。
 * 裸请求也可能被 WAF 拒，所以只在命中该文案时判定，其它情况交给真实浏览器流程。
 */
async function checkGeoBlocked() {
  try {
    const res = await fetch(CONSOLE_PAGE, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text().catch(() => '')
    if (/区域不支持访问/.test(text)) {
      throw new PluginError(
        'network',
        'trae.cn 按出口 IP 做了区域限制（当前网络不在中国大陆，官网返回「抱歉，您当前区域不支持访问」，浏览器会把它当成下载，登录窗口打不开）。请在大陆网络、或代理出口在大陆的环境下重试浏览器登录'
      )
    }
  } catch (e) {
    if (e instanceof PluginError) throw e
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
  await checkGeoBlocked()
  const page = await ensureSession(ctx)
  const notes: string[] = []
  const res: PluginFetchResult = { notes }

  // WAF 只放行页面自身请求：goto 首页触发 CheckLogin/GetUserInfo/pay/* 全套真实请求
  const bodies = await captureJsonResponses(page, KNOWN_ENDPOINTS, async () => {
    await page.goto(CONSOLE_PAGE, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(6000)
  })
  if (!Object.keys(bodies).length) {
    throw new PluginError('auth_expired', '控制台会话已失效（页面未发起任何已知 API），请重新浏览器登录')
  }

  const cl = (bodies.CheckLogin as { Result?: { IsLogin?: boolean; ExpiredAt?: number } } | undefined)?.Result
  if (cl && cl.IsLogin === false) {
    throw new PluginError('auth_expired', 'CheckLogin 返回未登录，请重新浏览器登录')
  }
  if (cl?.ExpiredAt) {
    const exp = new Date(cl.ExpiredAt)
    if (exp.getTime() < Date.now()) {
      throw new PluginError('auth_expired', `会话已过期（${exp.toLocaleString('zh-CN')}），请重新浏览器登录`)
    }
    notes.push(`会话有效至 ${exp.toLocaleString('zh-CN')}`)
  }

  // 账号
  const ui = (bodies.GetUserInfo as { Result?: Record<string, unknown> } | undefined)?.Result
  if (ui) {
    const nick = String(deepFind(ui, ['NickName', 'nick_name', 'Nickname', 'Name', 'AccountName', 'UserName', 'display_name']) ?? '')
    const email = String(deepFind(ui, ['EmailMasked', 'email_masked', 'Email', 'email', 'Mail']) ?? '')
    const phone = String(deepFind(ui, ['PhoneMasked', 'phone_masked', 'Phone', 'phone', 'Mobile', 'mobile']) ?? '')
    const uid = String(deepFind(ui, ['UserID', 'user_id', 'UserId', 'UniqueID', 'OID']) ?? '')
    const contact = email ? maskContact(email) : phone ? maskContact(phone) : uid ? `uid ${uid.slice(0, 6)}***` : ''
    res.account = { userName: nick || 'Trae 用户', maskedContact: contact, region: 'CN' }
    notes.push(`账号：${nick || '-'}${contact ? ` / ${contact}` : ''}${!nick && !contact ? `（GetUserInfo 键名待核对：${Object.keys(ui).slice(0, 8).join(',')}）` : ''}`)
  } else {
    notes.push('GetUserInfo 未捕获')
  }

  // 权益/积分用量 → 套餐名 + 配额窗口（真实积分）
  const ent = bodies.user_current_entitlement_list as Record<string, unknown> | undefined
  if (ent) {
    const pack = (ent.user_entitlement_pack_list as Array<Record<string, unknown>> | undefined)?.[0]
    const planName = String(pack?.display_desc ?? '')
    const us = ent.usage_summary as { consumed_amount?: number; consumption_ratio?: number; total_amount?: number } | undefined
    const renewal = isoOf(deepFind(ent, ['expire_time', 'expires_at', 'expired_at', 'renewal_time', 'next_charge_time', 'valid_until', 'expire_at']))
    // 价格：charge_amount 以「分」计（实测 Pro 连续包月 charge_amount=6900 → ¥69/月），
    // currency 为枚举（1=CNY）；单位无法确认时保持红色，不编数字
    const base = pack?.entitlement_base_info as Record<string, unknown> | undefined
    const charge = num(base?.charge_amount)
    const price = charge !== undefined && charge > 0 && num(base?.currency) === 1 ? charge / 100 : undefined
    const unknowns: Array<'price' | 'renewalDate' | 'autoRenew'> = ['autoRenew']
    if (price === undefined) unknowns.push('price')
    if (!renewal) unknowns.push('renewalDate')
    res.plan = { name: planName || 'Trae', currency: 'CNY', price, renewalDate: renewal ?? undefined, unknownFields: unknowns }
    if (price !== undefined) notes.push(`订阅价格：¥${price}/月（${planName || '会员'}）`)

    const consumed = num(us?.consumed_amount)
    const total = num(us?.total_amount)
    if (total !== undefined && total > 0) {
      const ratio = num(us?.consumption_ratio)
      res.windows = [
        {
          name: '会员积分额度',
          usedPct: Math.min(100, Math.max(0, (ratio ?? (consumed ?? 0) / total) * 100)),
          usedValue: consumed ?? 0,
          limitValue: total,
          unit: 'credits',
          resetAt: renewal ? `${renewal}T00:00:00+08:00` : null,
        },
      ]
      notes.push(`积分用量：${consumed ?? 0} / ${total}（${(((consumed ?? 0) / total) * 100).toFixed(1)}%）`)
    }
    notes.push(`权益样例：${JSON.stringify(ent).slice(0, 900)}`)
  } else {
    res.plan = { name: 'Trae', currency: 'CNY', unknownFields: ['price', 'renewalDate', 'autoRenew'] }
    notes.push('未捕获到 entitlement 接口（user_current_entitlement_list）')
  }

  if (bodies.cn_credits_billing_status) {
    notes.push(`计费状态：${JSON.stringify(bodies.cn_credits_billing_status).slice(0, 160)}`)
  }
  ctx.log(`会话采集：${Object.keys(bodies).join('、')}`)
  return res
}

export const traePlugin: ProviderPlugin = {
  id: 'trae',
  displayName: 'Trae',
  icon: '/icons/trae.svg',
  authMethods: ['browser-login'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://www.trae.cn',
  consoleUrl: CONSOLE_PAGE,

  async login(ctx: PluginContext) {
    await checkGeoBlocked()
    return runInteractiveLogin({
      providerId: ctx.providerId,
      dataDir: ctx.dataDir,
      consoleUrl: CONSOLE_PAGE,
      log: ctx.log,
      probe: async (page) => {
        // 字节通行证的会话 Cookie 落地即视为登录成功（CheckLogin 直调会被 WAF 拦截，Cookie 启发式更稳）
        const cookies = await page.context().cookies().catch(() => [])
        const hasSession = cookies.some((c) => /sessionid|uid_tt|passport_csrf|sid_guard/i.test(c.name))
        const onLoginRoute = /passport|login|signin/i.test(page.url())
        if (hasSession && !onLoginRoute) return { ok: true, desc: 'OK（检测到会话 Cookie）' }
        return {
          ok: false,
          desc: `url=${page.url().slice(0, 60)} cookies=${cookies.map((c) => c.name).filter((n) => /session|uid|passport|sid/i.test(n)).join(',') || '无'}`,
        }
      },
    })
  },

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'browser-login' || isLoggedIn(ctx.dataDir, ctx.providerId)) {
      if (!isLoggedIn(ctx.dataDir, ctx.providerId)) {
        throw new PluginError('not_configured', '尚未完成浏览器登录：详情页 → 更新凭证 → 浏览器登录')
      }
      return fetchViaBrowser(ctx)
    }
    throw new PluginError('not_configured', 'Trae 只支持浏览器登录（字节通行证会话）')
  },
}
