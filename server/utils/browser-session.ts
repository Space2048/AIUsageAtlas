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

// 取得（并首次加载）保活页面；已加载过的页面绝不重复导航
export async function ensureLivePage(providerId: string, dataDir: string, consoleUrl: string): Promise<Page> {
  let session = sessions.get(providerId)
  if (!session) session = await createSession(providerId, dataDir, consoleUrl)

  if (session.page && !session.page.isClosed()) return session.page

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

export async function startKeepAlive(providerId: string, dataDir: string, consoleUrl: string) {
  await ensureLivePage(providerId, dataDir, consoleUrl)
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

// 服务重启后恢复：为所有已登录的供应商重新挂上保活
export async function restoreKeepAlive(
  dataDir: string,
  providers: Array<{ id: string; consoleUrl: string }>
) {
  for (const p of providers) {
    if (isLoggedIn(dataDir, p.id)) {
      await startKeepAlive(p.id, dataDir, p.consoleUrl).catch(() => {})
    }
  }
}
