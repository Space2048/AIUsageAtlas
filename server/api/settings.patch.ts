import { getDb } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ displayCurrency?: string; fxRate?: number; timezone?: string }>(event)
  const db = getDb()
  const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)

  if (body.displayCurrency) upsert.run('display_currency', body.displayCurrency)
  if (body.fxRate !== undefined && body.fxRate > 0) upsert.run('fx_rate', String(body.fxRate))
  if (body.timezone) upsert.run('timezone', body.timezone)

  return { ok: true }
})
