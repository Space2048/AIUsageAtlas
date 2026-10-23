<script setup lang="ts">
// 窗口角色路由：
//  - 原生 ball 窗口：悬浮球本体 + 托盘动作 + 位置持久化 + 「球被按下」广播
//  - 原生 panel 窗口：展开面板，自己响应 atlas-toggle 决定显示/隐藏与站位
//  - 纯浏览器调试：单页内 ball + overlay 面板（?view=panel 可单独看面板）
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Ball from './components/Ball.vue'
import Panel from './components/Panel.vue'
import { useDashboard, openDashboard } from './api'
import { isNative, currentView, restoreBallPos, saveBallPosOnMove, onTrayAction, onBroadcast, broadcast, emitToggle, showPanelNear, computePanelPos, diag, PANEL_W, PANEL_H, type BallRect } from './tauri'
import { isStale } from './utils'

const native = isNative()
const view = currentView()
const overlay = ref(false)
const panelRef = ref<{ playOpen: () => void; playClose: () => Promise<void> } | null>(null)
// 弹出动画面板锚点：按「球在面板的哪个方位」决定 transform-origin 与进入偏移方向
const panelOrigin = ref({ ox: '50%', oy: '100%', ey: 10 })

// 悬浮球窗口独享一份数据（面板组件自带一份，互不干扰）
const dash = view === 'ball' ? useDashboard() : null
const stale = computed(() => (dash ? isStale(dash.lastOk.value) : false))

// 同一窗口内的 toggle 消息串行化：快速连点时 rect 读取的异步往返不能乱序
let chain: Promise<unknown> = Promise.resolve()
function serialize(fn: () => Promise<void>) {
  chain = chain.then(fn, fn)
  return chain
}

async function readBallRect(): Promise<BallRect> {
  const win = getCurrentWindow()
  const p = await win.outerPosition()
  const s = await win.outerSize()
  return { x: p.x, y: p.y, w: s.width, h: s.height }
}

function onToggle() {
  if (!native) {
    overlay.value = !overlay.value
    return
  }
  diag('ball toggle clicked')
  serialize(async () => emitToggle(await readBallRect()))
}

function onForceClose() {
  if (!native) {
    overlay.value = false
    return
  }
  diag('ball force-close (dblclick)')
  serialize(async () => emitToggle({ ...(await readBallRect()), force: true }))
}

function closeSelf() {
  if (native && view === 'panel') {
    void hidePanelNow()
  } else {
    overlay.value = false
  }
}

// ---------- 原生：ball 窗口职责 ----------
let hideTimer: ReturnType<typeof setTimeout> | undefined
function teardownBall() {
  window.removeEventListener('focus', onBallFocus)
}
function onBallFocus() {
  // 球被按下的瞬间面板会 blur——先通知面板撤销「失焦即隐藏」，避免点击球把面板闪没
  broadcast('atlas-ball-activated')
}

// ---------- 原生：panel 窗口职责 ----------
async function onPanelToggleMsg(rect: BallRect) {
  const win = getCurrentWindow()
  const visible = await win.isVisible().catch(() => false)
  diag(`panel got toggle rect=${JSON.stringify(rect)} visible=${visible}`)
  if (visible) {
    clearTimeout(hideTimer)
    await hidePanelNow()
    return
  }
  if (rect.force) return // 强制关闭时若已隐藏，什么都不做
  // 锚点朝向球：用与 showPanelNear 同一套定位公式推算面板将出现的位置，再取球相对方位
  try {
    const pos = await computePanelPos(rect)
    const ballCx = rect.x + rect.w / 2
    const ballCy = rect.y + rect.h / 2
    const panelCx = pos.x + PANEL_W / 2
    const panelCy = pos.y + PANEL_H / 2
    panelOrigin.value = {
      ox: ballCx < panelCx ? 'left' : 'right',
      oy: ballCy < panelCy ? 'top' : 'bottom',
      ey: ballCy < panelCy ? -8 : 8,
    }
  } catch {
    /* 算不出方位就用默认锚点 */
  }
  panelRef.value?.playOpen() // 重放展开动画（原生面板窗口 DOM 是复用的）
  await showPanelNear(rect)
}

// 隐藏前先播退场动画，再真正 hide 窗口
let panelHiding = false
async function hidePanelNow() {
  if (panelHiding) return
  panelHiding = true
  try {
    await panelRef.value?.playClose()
    await getCurrentWindow().hide().catch(() => {})
  } finally {
    panelHiding = false
  }
}

function onPanelBallActivated() {
  clearTimeout(hideTimer) // 球即将把 toggle 发来，撤销计划中的失焦隐藏
}

function onPanelBlur() {
  // 点面板外部 → 130ms 后隐藏（含退场动画）；期间若收到球的激活/切换信号则取消
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => void hidePanelNow(), 130)
}

onMounted(() => {
  if (native && view === 'ball') {
    window.addEventListener('focus', onBallFocus)
    window.addEventListener('mousedown', (e) => diag(`mousedown@${e.clientX},${e.clientY}`), true)
    window.addEventListener('mouseup', (e) => diag(`mouseup@${e.clientX},${e.clientY}`), true)
    restoreBallPos()
    saveBallPosOnMove()
    onTrayAction((action) => {
      diag(`tray action=${action}`)
      if (action === 'dashboard') openDashboard()
      else if (action === 'refresh') dash?.sync()
      else if (action === 'toggle-panel') onToggle()
    })
  }
  if (native && view === 'panel') {
    onBroadcast('atlas-toggle', (rect: BallRect) => serialize(() => onPanelToggleMsg(rect)))
    onBroadcast('atlas-ball-activated', onPanelBallActivated)
    // 面板开着时拖动悬浮球 → 立即收起面板
    onBroadcast('atlas-ball-dragging', () => {
      clearTimeout(hideTimer)
      void hidePanelNow()
    })
    window.addEventListener('blur', onPanelBlur)
  }
})

onBeforeUnmount(() => {
  if (native && view === 'ball') teardownBall()
  if (native && view === 'panel') window.removeEventListener('blur', onPanelBlur)
  clearTimeout(hideTimer)
})
</script>

<template>
  <div v-if="view === 'panel'">
    <Panel ref="panelRef" :overlay="!native" :origin="panelOrigin" @close="closeSelf" />
  </div>
  <div v-else class="stage">
    <Ball
      :native="native"
      :data="dash?.data.value ?? null"
      :error="dash?.error.value ?? ''"
      :loading="dash?.loading.value ?? true"
      :stale="stale"
      @toggle="onToggle"
      @force-close="onForceClose"
      @open-dashboard="openDashboard"
    />
    <Panel v-if="!native && overlay" overlay @close="closeSelf" />
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100%;
  height: 100%;
}
</style>
