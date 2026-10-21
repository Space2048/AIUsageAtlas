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
import { isNative, currentView, restoreBallPos, saveBallPosOnMove, onTrayAction, onBroadcast, broadcast, emitToggle, showPanelNear, type BallRect } from './tauri'
import { isStale } from './utils'

const native = isNative()
const view = currentView()
const overlay = ref(false)

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
  serialize(async () => emitToggle(await readBallRect()))
}

function onForceClose() {
  if (!native) {
    overlay.value = false
    return
  }
  serialize(async () => emitToggle({ ...(await readBallRect()), force: true }))
}

function closeSelf() {
  if (native && view === 'panel') {
    getCurrentWindow().hide().catch(() => {})
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
  if (visible) {
    clearTimeout(hideTimer)
    await win.hide().catch(() => {})
    return
  }
  if (rect.force) return // 强制关闭时若已隐藏，什么都不做
  await showPanelNear(rect)
}

function onPanelBallActivated() {
  clearTimeout(hideTimer) // 球即将把 toggle 发来，撤销计划中的失焦隐藏
}

function onPanelBlur() {
  // 点面板外部 → 130ms 后隐藏；期间若收到球的激活/切换信号则取消
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    getCurrentWindow()
      .hide()
      .catch(() => {})
  }, 130)
}

onMounted(() => {
  if (native && view === 'ball') {
    window.addEventListener('focus', onBallFocus)
    restoreBallPos()
    saveBallPosOnMove()
    onTrayAction((action) => {
      if (action === 'dashboard') openDashboard()
      else if (action === 'refresh') dash?.sync()
      else if (action === 'toggle-panel') onToggle()
    })
  }
  if (native && view === 'panel') {
    onBroadcast('atlas-toggle', (rect: BallRect) => serialize(() => onPanelToggleMsg(rect)))
    onBroadcast('atlas-ball-activated', onPanelBallActivated)
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
    <Panel :overlay="!native" @close="closeSelf" />
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
