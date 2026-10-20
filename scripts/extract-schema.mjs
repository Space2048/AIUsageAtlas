import { readFileSync } from 'node:fs'

// 用法: node scripts/extract-schema.mjs <bundle.js> <MessageType> [...]
// bundle 是控制台前端下载的 JS chunk，从中提取 protobuf 消息定义
const [bundlePath, ...names] = process.argv.slice(2)
if (!bundlePath || !names.length) {
  console.error('用法: node scripts/extract-schema.mjs <bundle.js> <MessageType> [...]')
  process.exit(1)
}
const src = readFileSync(bundlePath, 'utf8')

for (const n of names) {
  const marker = `makeMessageType("step.openapi.devcenter.${n}"`
  const i = src.indexOf(marker)
  if (i < 0) {
    console.log(`=== ${n}: not found ===`)
    continue
  }
  // 从 marker 开始扫到匹配的 ]
  let depth = 0
  let end = i
  for (let j = i; j < src.length && j < i + 6000; j++) {
    if (src[j] === '[') depth++
    else if (src[j] === ']') {
      depth--
      if (depth === 0) {
        end = j + 1
        break
      }
    }
  }
  console.log(`=== ${n} ===`)
  console.log(src.slice(i, end).replace(/\s+/g, ' ').slice(0, 1500))
  console.log()
}
