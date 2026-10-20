import { getDb } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{
    displayName?: string
    intervalSec?: number
    enabled?: boolean
    planPrice?: number
    planRenewalDate?: string | null
    autoRenew?: boolean
  }>(event)

  const db = getDb()
  const exists = db.prepare(`SELECT id FROM provider WHERE id = ?`).get(id)
  if (!exists) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  if (body.displayName) {
    db.prepare(`UPDATE provider SET display_name = ? WHERE id = ?`).run(body.displayName, id)
  }
  if (body.intervalSec !== undefined) {
    db.prepare(`UPDATE sync_config SET interval_sec = ? WHERE provider_id = ?`).run(
      Math.max(300, Math.round(body.intervalSec)),
      id
    )
  }
  if (body.enabled !== undefined) {
    db.prepare(`UPDATE sync_config SET enabled = ? WHERE provider_id = ?`).run(body.enabled ? 1 : 0, id)
  }
  if (body.planPrice !== undefined || body.planRenewalDate !== undefined || body.autoRenew !== undefined) {
    const row = db.prepare(`SELECT plan_name FROM subscription WHERE provider_id = ? LIMIT 1`).get(id) as
      | { plan_name: string }
      | undefined
    if (row) {
      db.prepare(
        `UPDATE subscription SET price = COALESCE(?, price), renewal_date = COALESCE(?, renewal_date), auto_renew = COALESCE(?, auto_renew) WHERE provider_id = ? AND plan_name = ?`
      ).run(
        body.planPrice ?? null,
        body.planRenewalDate ?? null,
        body.autoRenew === undefined ? null : body.autoRenew ? 1 : 0,
        id,
        row.plan_name
      )
    }
  }

  return { ok: true }
})
