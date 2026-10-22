// Tauri 桥接层：所有原生能力（窗口/事件/打开链接）都从这里走，
// 非 Tauri 环境（纯浏览器调试 ?view=ball|panel）下全部降级为 no-op / 简单 DOM 行为。
import { getCurrentWindow, PhysicalPosition, currentMonitor, monitorFromPoint, cursorPosition, type Monitor } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

// 诊断：把关键事件打进 tauri dev 控制台（仅原生环境）
export function diag(msg: string) {
  if (!isNative()) return
  invoke('diag', { msg }).catch(() => {})
}

export const PANEL_W = 380 // 与 tauri.conf.json 的 panel 窗口一致（卡片 340 + 四周 20px 光影余量）
export const PANEL_H = 500
export const BALL_W = 104 // 与 tauri.conf.json 的 ball 窗口一致（含光晕余量）
export const BALL_H = 104
const SNAP_EDGE = 28 // 距显示器边缘多少像素内触发磁吸
const SNAP_INSET = 0 // 吸附后与边缘的距离（0 = 完全贴边）
const PANEL_EDGE = 8 // 面板贴屏幕边时留的边距

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
    let edge: DockEdge | null = null
    if (mon) {
      // 允许 0 边距：贴边吸附的位置（挂到边框上）重启后要原样恢复
      nx = Math.min(Math.max(x, mon.position.x), mon.position.x + mon.size.width - BALL_W)
      ny = Math.min(Math.max(y, mon.position.y), mon.position.y + mon.size.height - BALL_H)
      // 落点贴任一边 → 恢复后直接进入收起态
      if (nx - mon.position.x <= 2) edge = 'left'
      else if (mon.position.x + mon.size.width - (nx + BALL_W) <= 2) edge = 'right'
      if (ny - mon.position.y <= 2) edge = edge ?? 'top'
      else if (mon.position.y + mon.size.height - (ny + BALL_H) <= 2) edge = edge ?? 'bottom'
    }
    await win.setPosition(new PhysicalPosition(Math.round(nx), Math.round(ny)))
    if (edge) {
      dockEdge = edge
      shownPos = { x: Math.round(nx), y: Math.round(ny) }
      void dockHide(false) // 启动时静默收起（无动画）
    }
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

// ---------- 边缘收纳（吸边自动收起 + 悬停滑出） ----------
// 停靠在屏幕边缘的球：松手且鼠标离开后滑出屏幕，只留 HIDE_VISIBLE 像素在屏内；
// 鼠标碰到露出的边条 → 滑回屏内；再离开 → 延时滑回。动画 = rAF 逐帧 setPosition + 三次缓出。
export type DockEdge = 'left' | 'right' | 'top' | 'bottom'

// 收起后留在屏幕内的窗口像素。必须 > 球体到窗口边的距离（(104-72)/2=16），
// 否则露出的全是透明区、看不到球——34 ≈ 露出约 18px 的球体月牙，作为「球停在这」的提示。
const HIDE_VISIBLE = 34
const HIDE_MS = 240 // 收起动画时长
const REVEAL_MS = 260 // 展开动画时长
const REHIDE_DELAY = 800 // 鼠标离开后多久收起

let dockEdge: DockEdge | null = null // 当前停靠的边（null = 未停靠，不自动收）
let shownPos: { x: number; y: number } | null = null // 完全在屏内的位置
let hideState: 'visible' | 'hiding' | 'hidden' | 'revealing' = 'visible'
let rehideTimer: ReturnType<typeof setTimeout> | undefined

export function getDockEdge(): DockEdge | null {
  return dockEdge
}

export function setDockEdge(edge: DockEdge | null) {
  dockEdge = edge
  if (!edge) clearTimeout(rehideTimer)
}

function offscreenTarget(pos: { x: number; y: number }, edge: DockEdge): { x: number; y: number } {
  const d = { left: BALL_W, right: BALL_W, top: BALL_H, bottom: BALL_H }[edge] - HIDE_VISIBLE
  const dx = { left: -d, right: d, top: 0, bottom: 0 }[edge]
  const dy = { left: 0, right: 0, top: -d, bottom: d }[edge]
  return { x: pos.x + dx, y: pos.y + dy }
}

async function tweenTo(target: { x: number; y: number }, ms: number) {
  const win = getCurrentWindow()
  const start = await win.outerPosition()
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms)
      const e = 1 - Math.pow(1 - t, 3) // easeOutCubic
      const x = Math.round(start.x + (target.x - start.x) * e)
      const y = Math.round(start.y + (target.y - start.y) * e)
      win.setPosition(new PhysicalPosition(x, y)).catch(() => {})
      if (t < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}

export async function dockHide(animate = true) {
  if (!dockEdge || hideState === 'hiding' || hideState === 'hidden') return
  const win = getCurrentWindow()
  const p = await win.outerPosition()
  shownPos = { x: p.x, y: p.y }
  const target = offscreenTarget(p, dockEdge)
  hideState = 'hiding'
  if (animate) await tweenTo(target, HIDE_MS)
  else await win.setPosition(new PhysicalPosition(target.x, target.y)).catch(() => {})
  if (hideState === 'hiding') hideState = 'hidden'
}

export async function dockReveal() {
  if (!shownPos || hideState === 'visible' || hideState === 'revealing') return
  clearTimeout(rehideTimer)
  hideState = 'revealing'
  await tweenTo(shownPos, REVEAL_MS)
  if (hideState === 'revealing') hideState = 'visible'
}

// 鼠标进入球（或收起后碰到露出的边条）
export function onBallEnter() {
  if (dockEdge && hideState !== 'visible') void dockReveal()
}

// 鼠标离开球：停靠态下延时收回
export function onBallLeave() {
  if (!dockEdge || hideState !== 'visible') return
  clearTimeout(rehideTimer)
  rehideTimer = setTimeout(() => void dockHide(true), REHIDE_DELAY)
}

// ---------- 拖拽 ----------
// data-tauri-drag-region 走 WM_NCLBUTTONDOWN/HTCAPTION，对无边框窗口不生效
// （事件被吃掉、窗口不动），改为 JS 驱动：按下记录光标与窗口的偏移，
// mousemove 时把窗口拉到「光标-偏移」处，窗口跟着光标走，事件流不断。
let dragActive = false
let dragMoved = false
let dragOffset = { x: 0, y: 0 }

export function beginDrag() {
  if (!isNative()) return
  dragMoved = false
  cursorPosition()
    .then(async (cur) => {
      const p = await getCurrentWindow().outerPosition()
      dragOffset = { x: cur.x - p.x, y: cur.y - p.y }
      dragActive = true
      diag(`drag begin cur=${cur.x},${cur.y} win=${p.x},${p.y}`)
    })
    .catch((e) => diag(`drag begin err ${e}`))
}

export function moveDrag() {
  if (!isNative() || !dragActive) return
  if (!dragMoved) {
    dragMoved = true
    // 拖动一开始就广播：面板若开着就自动收起
    void broadcast('atlas-ball-dragging')
  }
  cursorPosition()
    .then(async (cur) => {
      if (!dragActive) return
      let x = cur.x - dragOffset.x
      let y = cur.y - dragOffset.y
      // 边缘磁吸：光标所在显示器的工作区内，靠近任一边就吸上去（支持跨屏/角落）
      let snapped: DockEdge | null = null
      try {
        const mon = await monitorFromPoint(cur.x, cur.y)
        const area = (mon as any)?.workArea ?? (mon ? { position: mon.position, size: mon.size } : null)
        if (area) {
          const left = area.position.x
          const top = area.position.y
          const right = left + area.size.width
          const bottom = top + area.size.height
          if (Math.abs(x - left) <= SNAP_EDGE) {
            x = left + SNAP_INSET
            snapped = 'left'
          } else if (Math.abs(x + BALL_W - right) <= SNAP_EDGE) {
            x = right - BALL_W - SNAP_INSET
            snapped = 'right'
          }
          if (Math.abs(y - top) <= SNAP_EDGE) {
            y = top + SNAP_INSET
            snapped = snapped ?? 'top'
          } else if (Math.abs(y + BALL_H - bottom) <= SNAP_EDGE) {
            y = bottom - BALL_H - SNAP_INSET
            snapped = snapped ?? 'bottom'
          }
          // 兜底夹紧：拖拽过程不允许把球拖出工作区（防躲到任务栏后/屏幕外）
          x = Math.min(Math.max(x, left), right - BALL_W)
          y = Math.min(Math.max(y, top), bottom - BALL_H)
        }
      } catch {
        /* 拿不到显示器信息就不吸附 */
      }
      dockEdge = snapped // 拖动中实时更新停靠边（拖离边缘即取消停靠语义）
      return getCurrentWindow()
        .setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
    })
    .catch((e) => diag(`drag move err ${e}`))
}

export function endDrag() {
  dragActive = false
}

/** 本次按压是否发生了真实位移（供点击抑制与拖后逻辑使用） */
export function wasDragging(): boolean {
  return dragMoved
}

// ---------- 拖拽守卫 ----------
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
  diag(`emit atlas-toggle ${JSON.stringify(rect)}`)
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
      const maxX = mon.position.x + mon.size.width - PANEL_W - PANEL_EDGE
      const minX = mon.position.x + PANEL_EDGE
      x = Math.min(Math.max(x, minX), Math.max(minX, maxX))
      const below = mon.position.y + mon.size.height - PANEL_H - PANEL_EDGE
      if (y > below) y = Math.round(rect.y - PANEL_H - 10) // 下方放不下 → 球上方
      y = Math.min(Math.max(y, mon.position.y + PANEL_EDGE), Math.max(PANEL_EDGE, below))
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
