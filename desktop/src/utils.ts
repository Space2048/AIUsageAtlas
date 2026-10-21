// 格式化与时钟：逻辑与主站 pages/index.vue 保持同口径（UTC 日、K/M/B 缩写、三档阈值色）
import { ref } from 'vue'

// 全局 1 秒时钟：倒计时/相对时间/过期判定共用，只起一个 interval
export const now = ref(Date.now())
let started = false
function startClock() {
  if (started || typeof window === 'undefined') return
  started = true
  setInterval(() => (now.value = Date.now()), 1000)
}
startClock()

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

export function fmtCost(n: number, cur: string): string {
  const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : cur + ' '
  return sym + n.toFixed(2)
}

export function countdown(iso: string | null): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - now.value
  if (diff <= 0) return '已重置'
  const d = Math.floor(diff / 86400_000)
  const h = Math.floor((diff % 86400_000) / 3600_000)
  const m = Math.floor((diff % 3600_000) / 60_000)
  const s = Math.floor((diff % 60_000) / 1000)
  if (d > 0) return `${d}天${h}小时后重置`
  if (h > 0) return `${h}小时${m}分后重置`
  return `${m}分${s}秒后重置`
}

export function daysToRenewal(dateStr: string | null): { text: string; urgent: boolean } | null {
  if (!dateStr) return null
  const diff = new Date(dateStr + 'T00:00:00').getTime() - now.value
  const days = Math.ceil(diff / 86400_000)
  if (days < 0) return { text: '已过期', urgent: true }
  if (days === 0) return { text: '今日续费', urgent: true }
  return { text: `${days}天后续费`, urgent: days <= 3 }
}

export function pctClass(p: number): string {
  if (p >= 85) return 'danger'
  if (p >= 60) return 'warn'
  return 'good'
}

export function pctColor(p: number): string {
  if (p >= 85) return '#e8594f'
  if (p >= 60) return '#e0952a'
  return '#2fa36b'
}

// 配额窗口用量数字：采到才显示；上限 0/缺失时不显示「0 / 0」噪音
export function quotaValues(w: {
  usedValue: number | null
  limitValue: number | null
  unit: string
}): string {
  const fmt = (n: number) =>
    w.unit === 'usd' ? fmtCost(n, 'USD') : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)
  if (w.limitValue !== null && w.limitValue > 0 && w.usedValue !== null)
    return `${fmt(w.usedValue)} / ${fmt(w.limitValue)}`
  if (w.usedValue !== null && w.usedValue > 0) return `已用 ${fmt(w.usedValue)}`
  return ''
}

export function relTime(iso: string): string {
  const diff = Math.max(0, now.value - new Date(iso).getTime())
  const m = Math.floor(diff / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return `${h} 小时前`
}

// 粉彩头像回退（与主站 ProviderIcon.vue 同一套 palette + 种子哈希）
const PALETTE: Array<[string, string]> = [
  ['#ffe9df', '#f4643c'],
  ['#e0f3e9', '#2f9e6e'],
  ['#efe9ff', '#8b6bf0'],
  ['#e8efff', '#4a7dff'],
  ['#fdf0dc', '#e0952a'],
  ['#fde8e6', '#e8594f'],
]

export function avatarStyle(seed: string, size: number): Record<string, string> {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const [bg, fg] = PALETTE[h % PALETTE.length]
  return {
    background: bg,
    color: fg,
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: `${Math.round(size * 0.31)}px`,
    fontSize: `${Math.round(size * 0.33)}px`,
  }
}

export const STALE_MS = 30 * 60_000
export function isStale(lastOk: number): boolean {
  return lastOk > 0 && now.value - lastOk > STALE_MS
}
