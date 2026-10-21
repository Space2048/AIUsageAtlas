// 从仓库根 public/icon.svg 派生 1024x1024 透明 PNG，作为 `npx tauri icon` 的输入。
// 矢量源只有一个，和主站 scripts/generate-icons.mjs 同一思路。
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = resolve(HERE, '..', 'src-tauri', 'icons')

const svg = readFileSync(resolve(ROOT, 'public', 'icon.svg'), 'utf8')
const size = 1024
const sized = svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: size, height: size } })
await page.setContent(`<body style="margin:0">${sized}</body>`)
const buf = await page.screenshot({
  clip: { x: 0, y: 0, width: size, height: size },
  omitBackground: true,
})
await browser.close()

mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, 'icon-source.png'), buf)
console.log(`icon-source.png ${size}x${size} ok -> ${OUT}`)
