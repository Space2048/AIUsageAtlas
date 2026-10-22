import type { BrowserContext, Page } from 'playwright'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureProfileDir, isLoggedIn, profileDir } from '~~/server/utils/browser-profile'

// 浏览器登录型会话的关键认知（2026-10-20 实测）：
// 短效 token 的续期凭据保存在 SPA 的 JS 内存里（页面后台定时器自动续期），
// 因此保活 = 让页面一直活着且【绝不 reload】——reload 会清空内存、杀死续期能力；
// 而带过期 token 发请求会触发前端的 401 全局登出，把 cookie 全清掉，会话彻底报废。
// 同步只做 page.evaluate 取数，不改变页面状态。
//
// 第二层认知（MiMo 实测）：Chromium 不会把 session cookie（无 Expires）写进 profile，
// 所以「有头浏览器登录 → 关闭 → 无头重启」这条路对小米 passport 直接丢登录态。
// 因此登录成功后显式导出 storageState 到 profile 目录，之后每次新建 context 再注回去，
// 并在每次同步成功后刷新快照，让轮换过的 token 也能活过重启。

interface Session {
  context: BrowserContext
  page: Page | null
  consoleUrl: string
}

interface StoredState {
  cookies?: Parameters<BrowserContext['addCookies']>[0]
  origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
}

const sessions = new Map<string, Session>()

function stateFile(dataDir: string, providerId: string): string {
  return join(profileDir(dataDir, providerId), 'storage-state.json')
}

export async function persistStorageState(context: BrowserContext, dataDir: string, providerId: string) {
  const state = await context.storageState().catch(() => null)
  if (!state) return
  writeFileSync(stateFile(dataDir, providerId), JSON.stringify(state), 'utf8')
}

// 把当前保活会话的凭据快照回磁盘（同步成功后调用）
export async function snapshotSession(providerId: string, dataDir: string) {
  const s = sessions.get(providerId)
  if (s) await persistStorageState(s.context, dataDir, providerId)
}

async function restoreStoredState(context: BrowserContext, dataDir: string, providerId: string, consoleUrl: string) {
  const file = stateFile(dataDir, providerId)
  if (!existsSync(file)) return

  // profile 自己带回了该域的 Cookie 就不覆盖：快照可能比磁盘上的旧，
  // 拿它盖掉新鲜 Cookie 反而会把本来能用的会话弄坏（StepFun 走这条路）
  const origin = new URL(consoleUrl).origin
  const existing = await context.cookies(origin).catch(() => [])
  if (existing.length) return

  let state: StoredState
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as StoredState
  } catch {
    return
  }

  if (state.cookies?.length) await context.addCookies(state.cookies).catch(() => {})
  for (const o of state.origins ?? []) {
    if (!o.localStorage?.length) continue
    // addInitScript 对所有页面生效，按 origin 过滤后再写回 localStorage
    await context
      .addInitScript(([origin, items]: [string, Array<{ name: string; value: string }>]) => {
        if (location.origin !== origin) return
        for (const it of items) {
          try {
            localStorage.setItem(it.name, it.value)
          } catch {
            /* 配额或隐私模式 */
          }
        }
      }, [o.origin, o.localStorage] as [string, Array<{ name: string; value: string }>])
      .catch(() => {})
  }
}

async function createSession(providerId: string, dataDir: string, consoleUrl: string): Promise<Session> {
  const pw = await import('playwright')
  const dir = ensureProfileDir(dataDir, providerId)
  const context = await pw.chromium.launchPersistentContext(dir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    // 与登录窗口保持一致关掉 AutomationControlled：静默换发会经停 passport，
    // navigator.webdriver=true 会被风控拦下（见 launchLoginWindow 注释）
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await restoreStoredState(context, dataDir, providerId, consoleUrl)
  const session: Session = { context, page: null, consoleUrl }
  context.on('close', () => sessions.delete(providerId))
  sessions.set(providerId, session)
  return session
}

// 登录窗口用本机安装的 Chrome（界面/字体/习惯与用户日常一致），未安装时回退内置 Chromium。
// 仍是独立持久化 profile（.data/browser-profiles/<渠道>）：不是无痕，也不碰主 Chrome 配置，
// 登录一次后由快照与保活复用
export async function launchLoginWindow(pw: typeof import('playwright'), dataDir: string, providerId: string) {
  const dir = ensureProfileDir(dataDir, providerId)
  // AutomationControlled 会让 navigator.webdriver 暴露为 true，Google 登录风控会直接
  // 跳 signin/rejected「此浏览器或应用可能不安全」（2026-10-21 对照实测），必须关掉
  const base = {
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  }
  try {
    return await pw.chromium.launchPersistentContext(dir, { ...base, channel: 'chrome' })
  } catch (e) {
    // 失败原因必须留痕（此前被静默吞掉，连环 500 只能靠猜）；
    // 稍等再回退，让上一次失败尝试的 Chromium 先释放 profile 锁（连点/并发时会撞）
    console.warn(`[login] 本机 Chrome 启动失败，回退内置 Chromium：${(e as Error).message.split('\n')[0]}`)
    await new Promise((r) => setTimeout(r, 600))
    return await pw.chromium.launchPersistentContext(dir, base)
  }
}

// 插件的预换发钩子：会话页【加载之前】以纯 HTTP 用长效凭据换新短效 token。
// 必须在 goto 之前——过期快照让控制台 SPA 一加载就 401，而 SPA 的全局登出
// 会连带服务端吊销长效凭据（MiMo 实测 passToken 被吊销即无法自救），窗口只有一次
export type PreNavigate = (
  context: BrowserContext,
  opts: { dataDir: string; providerId: string; log?: (m: string) => void }
) => Promise<void>

// 取得（并首次加载）保活页面；已加载过的页面绝不重复导航
export async function ensureLivePage(
  providerId: string,
  dataDir: string,
  consoleUrl: string,
  opts?: { preNavigate?: PreNavigate; log?: (m: string) => void }
): Promise<Page> {
  let session = sessions.get(providerId)
  if (!session) session = await createSession(providerId, dataDir, consoleUrl)

  if (session.page && !session.page.isClosed()) return session.page

  // 首次/重建加载前预换发（纯 HTTP，页面还没机会发起 401）。
  // 换发失败必须【阻断 goto】并向上抛：带着过期 token 加载页面必然 401→
  // 全局登出，甚至服务端吊销长效凭据（见 PreNavigate 注释），宁可本次操作失败
  if (opts?.preNavigate) {
    await opts.preNavigate(session.context, { dataDir, providerId, log: opts.log })
  }

  const page = session.context.pages()[0] ?? (await session.context.newPage())
  await page.goto(consoleUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  // 等前端完成初始化与首轮 token 续期
  await page.waitForTimeout(6000)
  session.page = page
  return page
}

// 页面是否已加载且存活
export function isPageAlive(providerId: string): boolean {
  const s = sessions.get(providerId)
  return !!s?.page && !s.page.isClosed()
}

export async function startKeepAlive(
  providerId: string,
  dataDir: string,
  consoleUrl: string,
  opts?: { preNavigate?: PreNavigate; log?: (m: string) => void }
) {
  await ensureLivePage(providerId, dataDir, consoleUrl, opts)
}

export function hasSession(providerId: string): boolean {
  return sessions.has(providerId)
}

export async function closeSession(providerId: string) {
  const s = sessions.get(providerId)
  if (s) {
    sessions.delete(providerId)
    await s.context.close().catch(() => {})
  }
}

export async function closeAllSessions() {
  for (const id of [...sessions.keys()]) {
    await closeSession(id)
  }
}

// 服务重启后恢复：为所有已登录的供应商重新挂上保活（重启是预换发的关键入口——
// 快照里的短效 token 大概率已过期，不换发就会 401→全局登出→吊销长效凭据）
export async function restoreKeepAlive(
  dataDir: string,
  providers: Array<{ id: string; consoleUrl: string; preNavigate?: PreNavigate }>
) {
  for (const p of providers) {
    if (isLoggedIn(dataDir, p.id)) {
      await startKeepAlive(p.id, dataDir, p.consoleUrl, {
        preNavigate: p.preNavigate,
        log: (m) => console.log(`[keepalive ${p.id}] ${m}`),
      }).catch(() => {})
    }
  }
}

// ---------- 新渠道插件共用的三件套 ----------

/**
 * 交互式登录通用流程：本机 Chrome 开窗 → 轮询 probe → 成功即持久化+保活。
 * probe 返回诊断描述（desc），超时会带最近一次 desc，避免"黑盒超时"。
 */
export async function runInteractiveLogin(opts: {
  providerId: string
  dataDir: string
  consoleUrl: string
  log: (m: string) => void
  probe: (page: Page) => Promise<{ ok: boolean; desc: string }>
  waitMs?: number
}): Promise<{ ok: boolean; message: string }> {
  const pw = await import('playwright')
  // 先释放可能正被无头保活实例占用的 profile（双实例同开会互冲 Cookie）
  await closeSession(opts.providerId).catch(() => {})
  const context = await launchLoginWindow(pw, opts.dataDir, opts.providerId)
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(opts.consoleUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    opts.log('已打开浏览器，等待完成登录…')

    let closed = false
    context.on('close', () => {
      closed = true
    })
    const deadline = Date.now() + (opts.waitMs ?? 240_000)
    let last = '尚未探测'
    while (Date.now() < deadline) {
      if (closed) return { ok: false, message: '浏览器窗口已关闭，登录已取消' }
      await page.waitForTimeout(2500).catch(() => {})
      const r = await opts.probe(page).catch((e) => ({ ok: false, desc: `探测异常：${String(e).slice(0, 80)}` }))
      last = r.desc
      if (r.ok) {
        markLoggedIn(opts.dataDir, opts.providerId)
        await persistStorageState(context, opts.dataDir, opts.providerId).catch(() => {})
        await context.close().catch(() => {})
        await closeSession(opts.providerId).catch(() => {})
        await startKeepAlive(opts.providerId, opts.dataDir, opts.consoleUrl)
        return { ok: true, message: '登录成功，会话已保存并启动保活' }
      }
    }
    return { ok: false, message: `登录超时（4 分钟未检测到会话生效；最近探测：${last}），请重试` }
  } finally {
    await context.close().catch(() => {})
  }
}

/**
 * 页内同源 fetch（带会话 Cookie）。非抛错式：返回 status+data+text，
 * 由插件按平台语义解读（有些平台业务错误也回 HTTP 200）。
 */
export async function fetchInPageJson(
  page: Page,
  url: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; data: unknown; text: string }> {
  const result = page.evaluate(
    async ([u, initStr]) => {
      const init = JSON.parse(initStr as string) as { method?: string; body?: unknown; headers?: Record<string, string> }
      const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) }
      if (init.body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(u as string, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: 'include',
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        /* 非 JSON（网关 HTML 等） */
      }
      return { status: res.status, data, text: text.slice(0, 2000) }
    },
    [url, JSON.stringify(opts)] as [string, string]
  ) as Promise<{ status: number; data: unknown; text: string }>
  return Promise.race([
    result,
    new Promise<{ status: number; data: unknown; text: string }>((resolve) =>
      setTimeout(() => resolve({ status: 0, data: null, text: `请求超时（${url}）` }), 30_000)
    ),
  ])
}

/**
 * 控制台 API 流量采集：记录页面发出的 api 类请求（方法+路径）。
 * 新渠道首登后用它把未知接口"钓"出来写进同步日志，据此再精调采集。
 */
export function captureApiTraffic(page: Page): { list: () => string[]; stop: () => void } {
  const seen = new Set<string>()
  const onReq = (r: import('playwright').Request) => {
    const u = r.url()
    if (!/^https?:/.test(u)) return
    if (/\.(js|css|png|jpe?g|svg|woff2?|ico|map|gif|webp)(\?|$)/.test(u)) return
    if (!/\/(api|cloudide|bff|gw|jsonrpc|trae\/api)[a-zA-Z0-9/_.:-]/i.test(u)) return
    // 前端配置类噪音（横幅/错误文案/版本号等）不进样本，给业务 API 让位
    if (/\/api\/tcc\/|\/icube\/|operation-slots|\/imgextra\//.test(u)) return
    // 路径 + 请求体都要留全（RPC 型 POST 的 body 常含 Action/参数线索）
    const body = r.postData()
    seen.add(`${r.method()} ${u.replace(/^https?:\/\/[^/]+/, '').slice(0, 300)}${body ? ` body=${body.slice(0, 240)}` : ''}`)
  }
  page.on('request', onReq)
  return { list: () => [...seen], stop: () => page.off('request', onReq) }
}

/**
 * 响应采集型取数：有些平台（如 Trae）的 WAF 只放行页面自身发出的请求，
 * evaluate 直调会拿到挑战页 HTML —— 改为由 trigger() 触发页面真实加载，
 * 收集目标接口的 JSON 响应体（keys 为 URL 匹配子串，先到先得）。
 */
export async function captureJsonResponses(
  page: Page,
  keys: string[],
  trigger: () => Promise<void>
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const onResp = (r: import('playwright').Response) => {
    const u = r.url()
    const key = keys.find((k) => u.includes(k))
    if (!key || key in out) return
    r.text()
      .then((t) => {
        if (t && t.startsWith('{')) {
          try {
            out[key] = JSON.parse(t)
          } catch {
            /* 非 JSON */
          }
        }
      })
      .catch(() => {})
  }
  page.on('response', onResp)
  try {
    await trigger()
    // 给在途响应的 body 读取留出落地时间
    await new Promise((resolve) => setTimeout(resolve, 2500))
  } finally {
    page.off('response', onResp)
  }
  return out
}
