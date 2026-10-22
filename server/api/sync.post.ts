import { getDb } from '~~/server/utils/db'
import { runProviderSync } from '~~/server/utils/sync-runner'

export default defineEventHandler(async (event) => {
  // 空 body 时 readBody 解析成 undefined（不是 reject），必须再兜一层，
  // 否则前端「同步全部」（不带 body 调用）会 500
  const body = (await readBody<{ providerId?: string }>(event).catch(() => undefined)) ?? {}
  const db = getDb()
  const targets = body.providerId
    ? (db.prepare(`SELECT id FROM provider WHERE id = ?`).all(body.providerId) as Array<{ id: string }>)
    : (db.prepare(`SELECT id FROM provider`).all() as Array<{ id: string }>)

  const outcomes = []
  for (const t of targets) {
    outcomes.push(await runProviderSync(t.id))
  }

  const live = outcomes.filter((o) => o.mode === 'live').length
  const failed = outcomes.filter((o) => !o.ok).length
  return {
    ok: failed === 0,
    synced: outcomes.length,
    live,
    failed,
    results: outcomes,
    at: new Date().toISOString(),
  }
})
