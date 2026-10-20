import { getDb } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isFinite(id)) throw createError({ statusCode: 400, statusMessage: '非法 id' })
  const db = getDb()
  db.prepare(`DELETE FROM api_token WHERE id = ?`).run(id)
  return { ok: true }
})
