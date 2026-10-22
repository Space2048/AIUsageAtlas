<script setup lang="ts">
// 悬浮球：主数字 = 今日费用（折算 CNY），副字 = 今日 Token。
// 点击展开面板；双击打开 Web 仪表盘；拖拽用 data-tauri-drag-region + 位移守卫。
import { computed, onMounted, onBeforeUnmount } from 'vue'
import type { DashboardData } from '../../../shared/types'
import { beginPointer, endPointer, beginDrag, moveDrag, endDrag, onBallEnter, onBallLeave } from '../tauri'
import { fmtTokens, relTime } from '../utils'

const props = defineProps<{
  native: boolean
  data: DashboardData | null
  error: string
  loading: boolean
  stale: boolean
}>()

const emit = defineEmits<{
  toggle: []
  forceClose: []
  openDashboard: []
}>()

const cost = computed(() =>
  props.data ? '¥' + props.data.summary.todayCostCny.toFixed(2) : props.loading ? '…' : '—',
)
const tok = computed(() => (props.data ? fmtTokens(props.data.summary.todayTokens) : '—'))

const tip = computed(() => {
  const lines: string[] = []
  if (props.error) lines.push(`服务未连接：${props.error}`)
  if (props.data) {
    lines.push(
      `今日 ¥${props.data.summary.todayCostCny.toFixed(2)} · ${fmtTokens(props.data.summary.todayTokens)} tokens`,
    )
    lines.push(`数据截至 ${relTime(props.data.generatedAt)}`)
  }
  if (props.stale) lines.push('数据超过 30 分钟未更新')
  lines.push('单击看详情 · 双击打开仪表盘')
  return lines.join('\n')
})

function onClick() {
  if (endPointer()) return // 这一下是拖拽，不当成点击
  emit('toggle')
}

function onDbl() {
  // 双击 = 两次 toggle 已相互抵消，再强制收起面板并打开完整仪表盘
  emit('forceClose')
  emit('openDashboard')
}

function onDown() {
  beginPointer()
  beginDrag()
}

onMounted(() => {
  window.addEventListener('mousemove', moveDrag)
  window.addEventListener('mouseup', endDrag)
  window.addEventListener('blur', endDrag)
  // 边缘收纳：进入=滑出（若已收起），离开=延时滑回（若停靠在边上）
  document.addEventListener('mouseenter', onBallEnter)
  document.addEventListener('mouseleave', onBallLeave)
})
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', moveDrag)
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('blur', endDrag)
  document.removeEventListener('mouseenter', onBallEnter)
  document.removeEventListener('mouseleave', onBallLeave)
})
</script>

<template>
  <div
    class="ball"
    :class="{ native, err: !!error, nodata: !data }"
    :title="tip"
    @mousedown="onDown"
    @click="onClick"
    @dblclick="onDbl"
  >
    <div class="core">
      <div class="cost num">{{ cost }}</div>
      <div class="tok num">{{ tok }}<i>tok</i></div>
      <span v-if="error" class="badge bang" title="服务未连接">!</span>
      <span v-else-if="stale" class="badge dot" title="数据过期" />
    </div>
  </div>
</template>

<style scoped>
.ball {
  display: flex;
  align-items: center;
  justify-content: center;
}
.ball.native {
  position: absolute;
  inset: 0;
}
/* 纯浏览器调试时页面即窗口，球固定在左上角 */
.ball:not(.native) {
  position: fixed;
  top: 24px;
  left: 24px;
  width: 104px;
  height: 104px;
}

.core {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--coral-light), var(--coral));
  /* 光晕总伸展（圆半径 + 偏移 + 模糊）必须 ≤ 窗口半宽（104→52，含 hover 放大），
     否则会被方形窗口边界裁出可见的方框边缘 */
  box-shadow:
    0 2px 6px rgba(244, 100, 60, 0.45),
    0 4px 10px rgba(244, 100, 60, 0.15);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transition:
    transform 0.16s ease,
    filter 0.2s ease,
    opacity 0.2s ease;
}
.ball:hover .core {
  transform: scale(1.05);
}
.ball:active .core {
  transform: scale(0.96);
}

.cost {
  font-size: 15.5px;
  font-weight: 780;
  letter-spacing: -0.4px;
  color: #fff;
  line-height: 1.1;
  text-shadow: 0 1px 2px rgba(120, 40, 15, 0.22);
}
.tok {
  margin-top: 2px;
  font-size: 10px;
  font-weight: 620;
  color: rgba(255, 255, 255, 0.88);
  line-height: 1;
}
.tok i {
  font-style: normal;
  font-size: 8px;
  opacity: 0.72;
  margin-left: 1px;
}

.ball.nodata .cost,
.ball.nodata .tok {
  color: rgba(255, 255, 255, 0.78);
}

.ball.err .core {
  filter: saturate(0.45);
  opacity: 0.72;
}
.ball.err:hover .core {
  filter: saturate(0.6);
  opacity: 0.9;
}

.badge {
  position: absolute;
  right: -1px;
  bottom: 1px;
  background: #fff;
  box-shadow: 0 2px 6px rgba(38, 36, 31, 0.22);
}
.badge.bang {
  width: 19px;
  height: 19px;
  border-radius: 50%;
  color: var(--red);
  font-size: 13px;
  font-weight: 780;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.badge.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--text-faint);
  box-sizing: border-box;
}
</style>
