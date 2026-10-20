import { getDb } from '~~/server/utils/db'
import { getPlugin } from '~~/server/providers'
import { runProviderSync } from '~~/server/utils/sync-runner'

// 交互式浏览器登录：打开真实浏览器让用户登录，成功后会话持久化在 profile 目录
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = getDb()

  const provider = db
    .prepare(`SELECT id, plugin_id, display_name FROM provider WHERE id = ?`)
    .get(id) as { id: string; plugin_id: string; display_name: string } | undefined
  if (!provider) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  const plugin = getPlugin(provider.plugin_id)
  if (!plugin?.login) {
    throw createError({ statusCode: 400, statusMessage: `渠道 ${provider.plugin_id} 不支持浏览器登录` })
  }

  const logs: string[] = []
  const result = await plugin.login({
    providerId: id,
    dataDir: process.env.DATA_DIR || '.data',
    log: (m) => logs.push(m),
  })

  if (result.ok) {
    db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_msg) VALUES (?, 'ok', 0, ?)`)
      .run(id, '浏览器登录成功，会话已持久化')
    // 登录后立即同步一次，让数据和可能的遗留问题立刻暴露
    await runProviderSync(id).catch(() => {})
  } else {
    db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_type, error_msg) VALUES (?, 'failed', 0, 'auth_expired', ?)`)
      .run(id, `浏览器登录未完成：${result.message}`)
  }

  return { ...result, logs }
})
