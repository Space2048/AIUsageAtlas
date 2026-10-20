interface FetchJsonOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
  retries?: number
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const retries = opts.retries ?? 1
  let lastErr: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ac.signal,
      })
      const text = await res.text()
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
      }
      if (!res.ok) {
        const msg =
          (json && typeof json === 'object' && 'message' in json ? String((json as { message: unknown }).message) : '') ||
          `HTTP ${res.status}`
        const err = new Error(msg) as Error & { status?: number }
        err.status = res.status
        throw err
      }
      return json as T
    } catch (e) {
      lastErr = e
      const status = (e as { status?: number }).status
      // 4xx（除 429）不重试
      if (status && status >= 400 && status < 500 && status !== 429) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}
