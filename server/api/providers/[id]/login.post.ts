import { getDb } from '~~/server/utils/db'
import { getPlugin } from '~~/server/providers'
import { runProviderSync } from '~~/server/utils/sync-runner'

// 同渠道只允许一个登录流程：并发点击会让两个 Chromium 抢同一个 profile 目录，
// 后启动的直接崩在 launch（实测表现为连环 500 未处理错误）
const inFlight = new Set<string>()

// 交互式浏览器登录：打开真实浏览器让用户登录，成功后会话持久化在 profile 目录
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = getDb()

  const provider = db
    .prepare(`SELECT id, plugin_id, display_name, console_url FROM provider WHERE id = ?`)
    .get(id) as { id: string; plugin_id: string; display_name: string; console_url: string | null } | undefined
  if (!provider) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  const plugin = getPlugin(provider.plugin_id)
  if (!plugin?.login) {
    throw createError({ statusCode: 400, statusMessage: `渠道 ${provider.plugin_id} 不支持浏览器登录` })
  }
  if (inFlight.has(id)) {
    throw createError({ statusCode: 409, statusMessage: '该渠道已有登录流程进行中，请等当前登录窗口结束' })
  }
  inFlight.add(id)

  try {
    const logs: string[] = []
    let result: { ok: boolean; message: string }
    try {
      result = await plugin.login({
        providerId: id,
        dataDir: process.env.DATA_DIR || '.data',
        log: (m) => logs.push(m),
        // 多站点渠道用本实例选定的控制台地址（否则回退插件默认）
        consoleUrl: provider.console_url || plugin.consoleUrl,
      })
    } catch (e) {
      // 启动阶段异常（如 Chromium 撞 profile 锁）此前是未处理 500，UI 只能看到笼统错误：
      // 落一条 failed 日志并把首行返回给前端，方便定位
      const msg = ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 300)
      db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_type, error_msg) VALUES (?, 'failed', 0, 'network', ?)`)
        .run(id, `浏览器登录启动失败：${msg}`)
      return { ok: false as const, message: `登录启动失败：${msg}`, logs }
    }

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
  } finally {
    inFlight.delete(id)
  }
})
