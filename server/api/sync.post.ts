import { getDb } from '~~/server/utils/db'
import { runProviderSync } from '~~/server/utils/sync-runner'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ providerId?: string }>(event).catch(() => ({}) as { providerId?: string })
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
