import { getDb } from '~~/server/utils/db'

// 卡片顺序持久化：前端拖拽后把新的完整 id 序列发过来，按下标写 sort_order。
// 静态路由 /api/providers/order 优先于 /api/providers/[id]，不会被当成供应商 id 匹配掉
export default defineEventHandler(async (event) => {
  const body = await readBody<{ ids?: unknown }>(event).catch(() => undefined)
  const ids = body?.ids

  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    throw createError({ statusCode: 400, statusMessage: 'ids 必须是字符串数组' })
  }

  const db = getDb()
  const known = new Set(
    (db.prepare(`SELECT id FROM provider`).all() as Array<{ id: string }>).map((r) => r.id)
  )
  const upd = db.prepare(`UPDATE provider SET sort_order = ? WHERE id = ?`)

  let written = 0
  db.exec('BEGIN')
  try {
    for (const id of ids) {
      if (!known.has(id)) continue // 已被删除的渠道：忽略，不占序号
      upd.run(++written, id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  return { ok: true, written }
})
