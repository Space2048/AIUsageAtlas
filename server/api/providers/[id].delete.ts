import { getDb } from '~~/server/utils/db'
import { closeSession } from '~~/server/utils/browser-session'
import { clearProfile } from '~~/server/utils/browser-profile'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = getDb()
  const exists = db.prepare(`SELECT id FROM provider WHERE id = ?`).get(id)
  if (!exists) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  // 先关掉常驻浏览器会话并清理 profile，否则文件被 Chromium 锁定无法删除
  await closeSession(id).catch(() => {})
  clearProfile(process.env.DATA_DIR || '.data', id)

  for (const t of [
    'account_profile',
    'subscription',
    'quota_window',
    'usage_daily',
    'usage_model_daily',
    'balance_snapshot',
    'credential',
    'sync_config',
    'sync_log',
    'alert_rule',
  ]) {
    db.prepare(`DELETE FROM ${t} WHERE provider_id = ?`).run(id)
  }
  db.prepare(`DELETE FROM provider WHERE id = ?`).run(id)
  return { ok: true }
})
