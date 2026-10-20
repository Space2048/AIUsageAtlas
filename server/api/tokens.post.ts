import { getDb } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  const name = body?.name?.trim() || '未命名令牌'
  const raw = 'atlas-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  const db = getDb()
  db.prepare(`INSERT INTO api_token (name, token_hash) VALUES (?, ?)`).run(name, raw)
  // 仅创建时返回一次完整令牌
  return { ok: true, token: raw }
})
