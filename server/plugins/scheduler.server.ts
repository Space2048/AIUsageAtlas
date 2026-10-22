import { getDb } from '~~/server/utils/db'
import { runProviderSync } from '~~/server/utils/sync-runner'
import { closeAllSessions, restoreKeepAlive } from '~~/server/utils/browser-session'
import { listPlugins } from '~~/server/providers'

// 轻量调度器：每 60s 检查一次，按各供应商 sync_config.interval_sec + 抖动到期执行
// dev 模式 HMR 会重入，用 globalThis 守卫防重复注册

const TICK_MS = 60_000
const MAX_LOGS_PER_PROVIDER = 100

export default defineNitroPlugin((nitroApp) => {
  const g = globalThis as unknown as { __atlasScheduler?: ReturnType<typeof setInterval> }

  // 关服/热重载时必须关掉常驻浏览器：孤儿 Chromium 会一直占着 profile 目录，
  // 下一次登录写入的 Cookie 会被它内存里的空快照冲掉
  nitroApp.hooks.hook('close', async () => {
    if (g.__atlasScheduler) {
      clearInterval(g.__atlasScheduler)
      g.__atlasScheduler = undefined
    }
    await closeAllSessions()
  })

  if (g.__atlasScheduler) return

  const nextRunAt = new Map<string, number>()
  const dataDir = process.env.DATA_DIR || '.data'

  // 服务重启后为已登录的浏览器会话恢复保活页面
  const restore = () => {
    const db = getDb()
    const rows = db
      .prepare(`SELECT p.id, p.plugin_id, p.console_url FROM provider p JOIN credential c ON c.provider_id = p.id AND c.kind = 'browser-login'`)
      .all() as Array<{ id: string; plugin_id: string; console_url: string | null }>
    const providers = rows
      .map((r) => {
        const plugin = listPlugins().find((p) => p.id === r.plugin_id)
        const url = r.console_url || plugin?.consoleUrl
        return url ? { id: r.id, consoleUrl: url } : null
      })
      .filter((x): x is { id: string; consoleUrl: string } => !!x)
    if (providers.length) void restoreKeepAlive(dataDir, providers)
  }

  const tick = async () => {
    const db = getDb()
    const configs = db
      .prepare(`SELECT provider_id, interval_sec, jitter_sec FROM sync_config WHERE enabled = 1`)
      .all() as Array<{ provider_id: string; interval_sec: number; jitter_sec: number }>

    const now = Date.now()
    for (const c of configs) {
      const due = nextRunAt.get(c.provider_id)
      if (due === undefined) {
        // 首次注册：错开启动，避免齐步走
        nextRunAt.set(c.provider_id, now + (5_000 + Math.random() * 25_000))
        continue
      }
      if (now < due) continue

      nextRunAt.set(c.provider_id, now + (c.interval_sec + Math.random() * c.jitter_sec) * 1000)
      try {
        await runProviderSync(c.provider_id)
      } catch {
        /* runProviderSync 内部已记录 sync_log */
      }
    }

    // 日志裁剪：每个供应商只保留最近 N 条
    db.exec(`
      DELETE FROM sync_log WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY id DESC) AS rn
          FROM sync_log
        ) WHERE rn <= ${MAX_LOGS_PER_PROVIDER}
      )
    `)
  }

  setTimeout(() => void restore(), 3_000)
  const timer = setInterval(() => void tick(), TICK_MS)
  g.__atlasScheduler = timer

  process.on('beforeExit', () => clearInterval(timer))
})
