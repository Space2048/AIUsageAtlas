// Tauri 桥接层：所有原生能力（窗口/事件/打开链接）都从这里走，
// 非 Tauri 环境（纯浏览器调试 ?view=ball|panel）下全部降级为 no-op / 简单 DOM 行为。
import { getCurrentWindow, PhysicalPosition, currentMonitor, monitorFromPoint, type Monitor } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'

export const PANEL_W = 360
export const PANEL_H = 480
const BALL_GUARD = 80 // 悬浮球守卫尺寸，贴边时留出的边距

export function isNative(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
}

export function currentView(): 'ball' | 'panel' {
  if (isNative()) {
    try {
      return getCurrentWindow().label === 'panel' ? 'panel' : 'ball'
    } catch {
      /* fallthrough */
    }
  }
  return new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'ball'
}

// ---------- 广播（跨窗口） ----------
export async function broadcast(event: string, payload?: unknown) {
  if (!isNative()) return
  try {
    await emit(event, payload)
  } catch {
    /* 窗口已关闭等场景静默 */
  }
}

export async function onBroadcast(event: string, handler: (payload: any) => void) {
  if (!isNative()) return
  try {
    await listen(event, (e) => handler(e.payload))
  } catch {
    /* noop */
  }
}

// ---------- 悬浮球位置持久化 ----------
const POS_KEY = 'atlas-ball-pos'

export async function restoreBallPos() {
  if (!isNative()) return
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return
    const { x, y } = JSON.parse(raw) as { x: number; y: number }
    const win = getCurrentWindow()
    const mon = await currentMonitor()
    let nx = x
    let ny = y
    if (mon) {
      nx = Math.min(Math.max(x, mon.position.x + 4), mon.position.x + mon.size.width - BALL_GUARD)
      ny = Math.min(Math.max(y, mon.position.y + 4), mon.position.y + mon.size.height - BALL_GUARD)
    }
    await win.setPosition(new PhysicalPosition(Math.round(nx), Math.round(ny)))
  } catch {
    /* 位置异常时留给系统默认位置 */
  }
}

export function saveBallPosOnMove() {
  if (!isNative()) return
  const win = getCurrentWindow()
  let t: ReturnType<typeof setTimeout> | undefined
  win.onMoved(() => {
    clearTimeout(t)
    t = setTimeout(async () => {
      try {
        const p = await win.outerPosition()
        localStorage.setItem(POS_KEY, JSON.stringify({ x: p.x, y: p.y }))
      } catch {
        /* noop */
      }
    }, 350)
  })
}

// ---------- 拖拽守卫 ----------
// data-tauri-drag-region 走系统级窗口移动时，click 可能照常触发；
// 指针按下期间轮询窗口位置，位移超过阈值说明这一下是拖拽而不是点击。
let samples: Array<[number, number]> = []
let sampler: ReturnType<typeof setInterval> | undefined

export function beginPointer() {
  if (!isNative()) return
  samples = []
  const snap = async () => {
    try {
      const p = await getCurrentWindow().outerPosition()
      samples.push([p.x, p.y])
    } catch {
      /* noop */
    }
  }
  snap()
  sampler = setInterval(snap, 60)
  setTimeout(endPointer, 1200) // 兜底：click 未触发时回收轮询
}

export function endPointer(): boolean {
  if (sampler) {
    clearInterval(sampler)
    sampler = undefined
  }
  if (samples.length < 2) {
    samples = []
    return false
  }
  const xs = samples.map((s) => s[0])
  const ys = samples.map((s) => s[1])
  const moved = Math.max(...xs) - Math.min(...xs) > 3 || Math.max(...ys) - Math.min(...ys) > 3
  samples = []
  return moved
}

// ---------- 面板显示（由球所在窗口触发，面板窗口自行响应） ----------
export interface BallRect {
  x: number
  y: number
  w: number
  h: number
  force?: boolean
}

export function emitToggle(rect: BallRect) {
  return broadcast('atlas-toggle', rect)
}

// 面板窗口内：根据球的位置决定自己出现在哪（球下方优先，越界翻到上方并夹回屏内）
export async function showPanelNear(rect: BallRect) {
  const win = getCurrentWindow()
  try {
    // 面板此刻还隐藏着，按球的中心点找所在显示器（隐藏窗口的 currentMonitor 可能为 null）
    let mon: Monitor | null = null
    try {
      mon = await monitorFromPoint(Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2))
    } catch {
      /* 老版本没有 monitorFromPoint 时退化为不夹边 */
    }
    let x = Math.round(rect.x + rect.w / 2 - PANEL_W / 2)
    let y = Math.round(rect.y + rect.h + 10)
    if (mon) {
      const maxX = mon.position.x + mon.size.width - PANEL_W - BALL_GUARD
      const minX = mon.position.x + BALL_GUARD
      x = Math.min(Math.max(x, minX), Math.max(minX, maxX))
      const below = mon.position.y + mon.size.height - PANEL_H - BALL_GUARD
      if (y > below) y = Math.round(rect.y - PANEL_H - 10) // 下方放不下 → 球上方
      y = Math.min(Math.max(y, mon.position.y + BALL_GUARD), Math.max(BALL_GUARD, below))
    }
    await win.setPosition(new PhysicalPosition(x, y))
    await win.show()
    await win.setFocus()
  } catch {
    /* 极端情况下至少让它露面 */
    await win.show().catch(() => {})
  }
}

// ---------- 托盘动作（Rust 侧广播） ----------
export function onTrayAction(handler: (action: string) => void) {
  onBroadcast('tray-action', handler)
}
