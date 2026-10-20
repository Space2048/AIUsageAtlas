// 把用户各种粘贴格式统一成标准 Cookie 头字符串（name=value; name2=value2）
// 支持：原始串、带 "Cookie:" 前缀、cURL -H 命令、DevTools JSON 数组/对象、Netscape cookies.txt
export function normalizeCookie(input: string): string {
  let s = (input || '').trim()
  if (!s) return ''

  // cURL 命令：提取 -H 'Cookie: ...' / --header "Cookie: ..."
  const curlMatch = s.match(/(?:-H|--header)\s+['"]Cookie:\s*([^'"]+)['"]/i)
  if (curlMatch) s = curlMatch[1].trim()

  // 带 "Cookie:" / "cookie:" 前缀
  s = s.replace(/^cookie\s*:\s*/i, '').trim()

  // JSON 数组：[{"name":"a","value":"b"}, ...]
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s) as Array<{ name?: string; value?: string }>
      if (Array.isArray(arr) && arr.length) {
        return arr
          .filter((c) => c && c.name)
          .map((c) => `${c.name}=${c.value ?? ''}`)
          .join('; ')
      }
    } catch {
      /* 不是合法 JSON，按原串处理 */
    }
  }

  // JSON 对象：{"a":"b", ...}
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Record<string, string>
      const keys = Object.keys(obj)
      if (keys.length) {
        return keys.map((k) => `${k}=${obj[k]}`).join('; ')
      }
    } catch {
      /* 按原串处理 */
    }
  }

  // Netscape cookies.txt：domain \t flag \t path \t secure \t expires \t name \t value
  if (/^[^\s\t]+\t(TRUE|FALSE)\t/i.test(s)) {
    const pairs = s
      .split(/\r?\n/)
      .map((line) => {
        const f = line.split('\t')
        return f.length >= 7 && f[5] ? `${f[5]}=${f[6] ?? ''}` : null
      })
      .filter(Boolean)
    if (pairs.length) return pairs.join('; ')
  }

  // 原始串：统一分号间距，保留值内字符
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // 每行都是 name=value（如从表格复制的多行）→ 用分号连接；否则视为同一行的折行
  const joined =
    lines.length > 1 && lines.every((l) => /^[^=;]+=/.test(l)) ? lines.join('; ') : lines.join(' ')
  return joined.replace(/\s*;\s*/g, '; ').trim()
}
