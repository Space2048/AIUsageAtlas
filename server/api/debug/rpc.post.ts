import { ensureLivePage } from '~~/server/utils/browser-session'
import { getDb } from '~~/server/utils/db'

// 调试接口：借道活动会话页面直调控制台接口，用于验证参数组合与响应结构。
// path 为完整路径（如 /api/v1/balance）；StepFun 的 RPC 仍可只给 method + rpcBase。
// 仅本机/内网使用，不对外暴露
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    providerId: string
    consoleUrl: string
    path?: string
    method?: string
    rpcBase?: string
    httpMethod?: 'GET' | 'POST'
    headers?: Record<string, string>
    args?: unknown
    navigate?: boolean
  }>(event)

  if (!body?.providerId || (!body.path && !body.method)) {
    throw createError({ statusCode: 400, statusMessage: 'providerId 与 path/method 必填' })
  }

  const db = getDb()
  const provider = db.prepare(`SELECT id, plugin_id FROM provider WHERE id = ?`).get(body.providerId)
  if (!provider) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  const page = await ensureLivePage(body.providerId, process.env.DATA_DIR || '.data', body.consoleUrl)

  // navigate=true：只强制导航一次并回报落地地址与该 profile 里的全部 Cookie，
  // 用于判断会话 Cookie 是否真的落盘（不带参数 = 不按当前 origin 过滤）
  if (body.navigate) {
    await page.goto(body.consoleUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(4000)
    const cookies = await page.context().cookies().catch(() => [])
    return {
      status: 200,
      body: '',
      pageUrl: page.url(),
      cookieNames: cookies.map((c) => `${c.domain}:${c.name}:exp${c.expires}`),
    }
  }

  const url = body.path || (body.rpcBase || '/api/step.openapi.devcenter.Dashboard/') + body.method
  const httpMethod = body.httpMethod ?? (body.path ? 'GET' : 'POST')
  // StepFun 控制台缺这三个头会把合法 token 判为盗用；其它渠道不额外加
  const stepHeaders = url.includes('/api/step.')
    ? { 'connect-protocol-version': '1', 'oasis-appid': '10300', 'oasis-platform': 'web' }
    : {}

  const result = await page
    .evaluate(
      async ([req]) => {
        const r = await fetch(req.url, {
          method: req.httpMethod,
          headers: { 'Content-Type': 'application/json', ...req.headers },
          body: req.httpMethod === 'GET' ? undefined : JSON.stringify(req.args ?? {}),
          credentials: 'include',
        })
        const text = await r.text()
        return { status: r.status, body: text.slice(0, 6000), cookieNames: document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean) }
      },
      [{ url, httpMethod, headers: { ...stepHeaders, ...body.headers }, args: body.args }] as [
        { url: string; httpMethod: string; headers: Record<string, string>; args: unknown },
      ]
    )
    .catch((e: Error) => ({ status: -1, body: e.message, cookieNames: [] }))

  // pageUrl 用于判断保活页面是否被弹到了 passport 登录域
  return { ...result, pageUrl: page.url() }
})
