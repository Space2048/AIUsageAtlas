import { getDb } from '~~/server/utils/db'
import type { AppSettings, TokenInfo } from '~~/shared/types'

export default defineEventHandler((): { settings: AppSettings; tokens: TokenInfo[]; alerts: Array<Record<string, never>> } => {
  const db = getDb()
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]))

  // created_at / last_used_at 由 datetime('now') 写入，是无时区标记的 UTC 串；转成带 Z 的 ISO 8601，前端才能按本地时间渲染
  const tokens = (
    db
      .prepare(
        `SELECT id, name, token_hash,
                COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), created_at) AS created_at,
                CASE WHEN last_used_at IS NULL THEN NULL
                     ELSE COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_used_at), last_used_at) END AS last_used_at
         FROM api_token ORDER BY id`
      )
      .all() as Array<Record<string, never>>
  ).map((t) => ({
    id: t.id,
    name: t.name,
    masked: t.token_hash.slice(0, 8) + '••••••••' + t.token_hash.slice(-4),
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
  }))

  const alerts = db.prepare(`SELECT id, provider_id, metric, threshold, enabled FROM alert_rule ORDER BY id`).all() as Array<Record<string, never>>

  return {
    settings: {
      displayCurrency: kv.display_currency || 'CNY',
      fxRate: Number(kv.fx_rate || 7.1),
      timezone: kv.timezone || 'Asia/Shanghai',
    },
    tokens,
    alerts,
  }
})
