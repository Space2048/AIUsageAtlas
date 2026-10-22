import { getDb } from '~~/server/utils/db'
import { getPlugin } from '~~/server/providers'
import { runProviderSync } from '~~/server/utils/sync-runner'

// MVP：凭证以 JSON 明文落库（加密存储见 docs/01-architecture.md §6 风险3，待插件系统稳定后统一处理）
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    pluginId: string
    displayName?: string
    authKind?: string
    authValue?: string
    consoleUrl?: string
  }>(event)

  if (!body?.pluginId) {
    throw createError({ statusCode: 400, statusMessage: 'pluginId 必填' })
  }

  const plugin = getPlugin(body.pluginId)
  const db = getDb()

  // 多站点渠道（如 Qoder 国内/全球）：站点必须来自插件声明，防注入
  let consoleUrl = ''
  if (body.consoleUrl) {
    if (!plugin?.sites?.some((s) => s.consoleUrl === body.consoleUrl)) {
      throw createError({ statusCode: 400, statusMessage: 'consoleUrl 不是该渠道声明的站点' })
    }
    consoleUrl = body.consoleUrl
  }

  const id = `${body.pluginId}-${Date.now().toString(36)}`
  db.prepare(`INSERT INTO provider (id, plugin_id, display_name, category, icon, console_url) VALUES (?, ?, ?, 'api', ?, ?)`).run(
    id,
    body.pluginId,
    body.displayName || plugin?.displayName || body.pluginId,
    plugin?.icon ?? '',
    consoleUrl
  )
  db.prepare(`INSERT INTO sync_config (provider_id, interval_sec) VALUES (?, ?)`).run(
    id,
    plugin?.scheduleDefaultSec ?? 3600
  )

  const authKind = body.authKind || plugin?.authMethods[0] || 'apikey'
  if (authKind === 'browser-login') {
    // 浏览器登录模式：先建档，凭证在登录成功后由 profile 承载
    db.prepare(
      `INSERT OR REPLACE INTO credential (provider_id, kind, payload_enc) VALUES (?, 'browser-login', ?)`
    ).run(id, JSON.stringify({ kind: 'browser-login' }))
  } else if (body.authValue) {
    const payload =
      authKind === 'apikey' ? JSON.stringify({ kind: 'apikey', apiKey: body.authValue }) : JSON.stringify({ kind: authKind, cookie: body.authValue })
    db.prepare(
      `INSERT OR REPLACE INTO credential (provider_id, kind, payload_enc) VALUES (?, ?, ?)`
    ).run(id, authKind, payload)
  }

  // 添加后立即在后台跑一次同步，让首屏有数据（不阻塞响应）
  runProviderSync(id).catch(() => {})

  return { ok: true, id, authKind }
})
