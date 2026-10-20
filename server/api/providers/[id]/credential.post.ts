import { getDb } from '~~/server/utils/db'
import { runProviderSync } from '~~/server/utils/sync-runner'

// 更新已有供应商的凭证（Cookie/API Key），保存后立即同步一次
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ kind?: string; value?: string }>(event)

  const kind = body?.kind
  const value = body?.value?.trim()
  if (!kind || !value) {
    throw createError({ statusCode: 400, statusMessage: 'kind 和 value 必填' })
  }

  const db = getDb()
  const exists = db.prepare(`SELECT id FROM provider WHERE id = ?`).get(id)
  if (!exists) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  const payload =
    kind === 'apikey' ? JSON.stringify({ kind: 'apikey', apiKey: value }) : JSON.stringify({ kind, cookie: value })

  db.prepare(
    `INSERT INTO credential (provider_id, kind, payload_enc, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(provider_id, kind) DO UPDATE SET payload_enc = excluded.payload_enc, updated_at = datetime('now')`
  ).run(id, kind, payload)

  const outcome = await runProviderSync(id)
  return {
    ok: outcome.ok,
    mode: outcome.mode,
    error: outcome.error,
    syncedAt: new Date().toISOString(),
  }
})
