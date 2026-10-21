import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// 从 public/icon.svg 派生位图图标（矢量源只有一个，避免手改多份 PNG）
//   node scripts/generate-icons.mjs
// 产出:
//   public/favicon.ico            16/32/48 三档（老浏览器/系统缩略图兜底）
//   public/apple-touch-icon.png   180x180 满幅不圆角（iOS 自己做遮罩，透明角会发黑）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICON = readFileSync(resolve(ROOT, 'public/icon.svg'), 'utf8')

const sized = (svg, size) =>
  svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)

const browser = await chromium.launch()

async function renderPng(svg, size, { transparent = false } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<body style="margin:0">${svg}</body>`)
  // transparent: 截图默认把页面画成白底，圆角外和抗锯齿边缘会被烘焙成白边，
  // 透明 favicon 必须 omitBackground 才能让边缘正确混到透明上
  const buf = await page.screenshot({
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: transparent,
  })
  await page.close()
  return buf
}

// favicon.ico：PNG 压缩条目（Vista 起各平台均支持），比调色板 ICO 更保真
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4) // count
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // colors in palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)])
}

const icoSizes = [16, 32, 48]
const icoPngs = []
for (const size of icoSizes) {
  icoPngs.push({ size, png: await renderPng(sized(ICON, size), size, { transparent: true }) })
  console.log(`favicon ${size}x${size} ok`)
}
writeFileSync(resolve(ROOT, 'public/favicon.ico'), buildIco(icoPngs))

const touch = await renderPng(sized(ICON.replace('rx="112"', 'rx="0"'), 180), 180)
writeFileSync(resolve(ROOT, 'public/apple-touch-icon.png'), touch)
console.log('apple-touch-icon 180x180 ok')

await browser.close()
