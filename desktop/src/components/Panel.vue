<script setup lang="ts">
// 展开面板：三格汇总 + 分组额度（需关注展开 / 正常单行）+ 抽屉式设置。
// 原生模式是独立窗口（380x500），浏览器调试模式是页面内 overlay。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { DashboardData, ProviderVM, QuotaWindow } from '../../../shared/types'
import { useDashboard, getBase, setBase, iconUrl, openDashboard } from '../api'
import { isNative } from '../tauri'
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import {
  fmtTokens,
  fmtCost,
  countdown,
  daysToRenewal,
  pctClass,
  pctColor,
  relTime,
  avatarStyle,
} from '../utils'

const props = withDefaults(
  defineProps<{ overlay: boolean; origin?: { ox: string; oy: string; ey: number } }>(),
  { origin: () => ({ ox: '50%', oy: '100%', ey: 10 }) },
)
const emit = defineEmits<{ close: [] }>()

// 开/关动画：原生面板窗口复用（不重挂载），openKey 重挂载卡片重放入场动画；
// 关闭加 .closing 播完退场动画再由外层 hide 窗口。
const openKey = ref(0)
const closing = ref(false)
let closingSince = 0
const CLOSE_MS = 150

function playOpen() {
  openKey.value++
  closing.value = false
}

async function playClose() {
  if (closing.value) {
    const left = CLOSE_MS - (Date.now() - closingSince)
    if (left > 0) await new Promise((r) => setTimeout(r, left))
    return
  }
  closing.value = true
  closingSince = Date.now()
  await new Promise((r) => setTimeout(r, CLOSE_MS))
}

defineExpose({ playOpen, playClose })

const { data, error, loading, syncing, load, sync } = useDashboard()

const providers = computed(() => data.value?.providers ?? [])

// ---- 置顶：用户自选最多 2 个供应商置顶展示（localStorage 持久化） ----
const MAX_PINS = 2
const PINS_KEY = 'atlas-pins'

function loadPins(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(PINS_KEY) || '[]')
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, MAX_PINS) : []
  } catch {
    return []
  }
}
const pins = ref<string[]>(loadPins())
function savePins() {
  localStorage.setItem(PINS_KEY, JSON.stringify(pins.value))
}
function isPinned(p: ProviderVM): boolean {
  return pins.value.includes(p.id)
}
// 置顶第 3 个时挤掉最早置顶的那个（队列语义）
function togglePin(p: ProviderVM) {
  if (isPinned(p)) {
    pins.value = pins.value.filter((id) => id !== p.id)
  } else {
    pins.value = [...pins.value, p.id].slice(-MAX_PINS)
  }
  savePins()
}
const pinTitle = (p: ProviderVM) =>
  isPinned(p) ? '取消置顶' : pins.value.length >= MAX_PINS ? '置顶（替换最早的一个）' : '置顶'

const pinned = computed(() =>
  pins.value
    .map((id) => providers.value.find((p) => p.id === id))
    .filter((p): p is ProviderVM => !!p),
)
const rest = computed(() =>
  providers.value
    .filter((p) => !pins.value.includes(p.id))
    .sort((a, b) => worstPct(b) - worstPct(a)),
)

// ---- 工具：最紧张窗口（置顶卡展示全部窗口，单行列表取最紧张一个） ----
function worstWindow(p: ProviderVM): QuotaWindow | null {
  let worst: QuotaWindow | null = null
  for (const w of p.windows) if (!worst || w.usedPct > worst.usedPct) worst = w
  return worst
}
const worstPct = (p: ProviderVM) => (worstWindow(p)?.usedPct ?? -1)

// ---- 头像（渠道 logo 加载失败回退粉彩字模） ----
const broken = ref(new Set<string>())
function avatarImg(p: ProviderVM): string {
  if (!p.icon || broken.value.has(p.id)) return ''
  return iconUrl(p.icon)
}
function markBroken(p: ProviderVM) {
  broken.value.add(p.id)
}

// ---- 设置抽屉 ----
const showSettings = ref(false)
const draft = ref('')

function openSettings() {
  draft.value = getBase()
  showSettings.value = true
}
function closeSettings() {
  showSettings.value = false
}
// 抽屉里没有独立保存按钮：回车或输入即生效
function saveSettings() {
  const v = draft.value.trim()
  if (!v) return
  const changed = v !== getBase()
  setBase(v)
  if (changed) void load()
}
function onDraftInput() {
  const v = draft.value.trim()
  if (v && /^https?:\/\//.test(v) && v !== getBase()) {
    setBase(v)
    void load()
  }
}

// ---- 开机自启（写 HKCU Run 键，随当前 exe 路径） ----
const autostartOn = ref(false)
const autostartBusy = ref(false)
async function refreshAutostart() {
  if (!isNative()) return
  try {
    autostartOn.value = await isAutostartEnabled()
  } catch {
    /* 查询失败保持现状 */
  }
}
async function toggleAutostart() {
  if (!isNative() || autostartBusy.value) return
  autostartBusy.value = true
  try {
    if (autostartOn.value) await disableAutostart()
    else await enableAutostart()
    autostartOn.value = await isAutostartEnabled()
  } catch {
    autostartOn.value = await isAutostartEnabled().catch(() => autostartOn.value)
  } finally {
    autostartBusy.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
  void refreshAutostart()
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

function summaryCost(d: DashboardData | null): string {
  return d ? '¥' + d.summary.todayCostCny.toFixed(2) : '—'
}
function summaryTokens(d: DashboardData | null): string {
  return d ? fmtTokens(d.summary.todayTokens) : '—'
}

// 面板紧凑口径：超长整数换 B/K 缩写（6,570,269,648 → 6.57B）
function fmtQty(n: number): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K'
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)
}

function quotaValues(w: QuotaWindow | null): string {
  if (!w) return ''
  const fmt = (n: number) => (w.unit === 'usd' ? fmtCost(n, 'USD') : fmtQty(n))
  if (w.limitValue !== null && w.limitValue > 0 && w.usedValue !== null)
    return `${fmt(w.usedValue)} / ${fmt(w.limitValue)}`
  if (w.usedValue !== null && w.usedValue > 0) return `已用 ${fmt(w.usedValue)}`
  return ''
}

const APP_VERSION = '0.1.0'

// 正常组单行宽度有限：倒计时去掉「后重置」后缀防换行（6天9小时后重置 → 6天9小时）
const shortCountdown = (iso: string | null) => countdown(iso).replace('后重置', '')

// 弹出动画锚点（来自 App 按球的方位计算）：transform-origin + 进入偏移方向
const cardAnimStyle = computed<Record<string, string>>(() => ({
  transformOrigin: `${props.origin.ox} ${props.origin.oy}`,
  '--enter-y': `${props.origin.ey}px`,
}))
</script>

<template>
  <div class="panel" :class="{ overlay: props.overlay }">
    <div v-if="props.overlay" class="backdrop" @click="emit('close')" />
    <div class="card" :class="{ closing }" :key="openKey" :style="cardAnimStyle">
      <!-- 头部：监控态 vs 设置抽屉态 -->
      <header class="hd">
        <template v-if="!showSettings">
          <img class="brand" :src="`${getBase()}/icon.svg`" alt="" />
          <div class="hd-title">
            AIUsageAtlas
            <span class="hd-count num">{{ providers.length }} 渠道</span>
          </div>
          <button class="pill" title="打开完整 Web 仪表盘" @click="openDashboard">仪表盘 ↗</button>
          <button class="ib" title="同步全部" :disabled="syncing" @click="sync">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: syncing }">
              <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
            </svg>
          </button>
          <button class="ib" title="设置" @click="openSettings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"
              />
            </svg>
          </button>
          <button class="ib ib-close" title="关闭（Esc）" @click="emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        </template>
        <template v-else>
          <button class="ib" title="返回监控" @click="closeSettings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M19 12H5M12 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <div class="hd-title hd-title-set">设置</div>
          <button class="ib ib-close" title="关闭（Esc）" @click="emit('close')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        </template>
      </header>

      <div v-if="error && !showSettings" class="err-banner">
        <span class="err-text">服务未连接 — {{ error }}</span>
        <button class="retry" @click="load">重试</button>
      </div>

      <!-- ================= 设置抽屉（原位替换内容区） ================= -->
      <template v-if="showSettings">
        <div class="set-body">
          <div class="set-grp">连接</div>
          <div class="set-card">
            <div class="set-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>
              <div class="set-lab"><b>服务器地址</b><i>Nuxt 服务的 REST 入口</i></div>
            </div>
            <input
              v-model="draft"
              class="set-input"
              placeholder="http://127.0.0.1:3000"
              spellcheck="false"
              @input="onDraftInput"
              @keydown.enter="saveSettings"
            />
            <div class="set-row" :class="error ? 'bad' : 'ok'">
              <svg v-if="!error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 8v5M12 17h.01" stroke-linecap="round"/><circle cx="12" cy="12" r="9"/></svg>
              <span v-if="!error">连接正常 · {{ providers.length }} 渠道 · 数据 {{ data ? relTime(data.generatedAt) : '—' }}</span>
              <span v-else>连接失败 — {{ error }}</span>
            </div>
          </div>

          <div class="set-grp">启动</div>
          <div class="set-card">
            <div class="set-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/></svg>
              <div class="set-lab"><b>开机自启</b><i>登录 Windows 后自动启动悬浮球</i></div>
              <button
                class="sw"
                :class="{ on: autostartOn }"
                :disabled="autostartBusy || !isNative()"
                role="switch"
                :aria-checked="autostartOn"
                aria-label="开机自启"
                @click="toggleAutostart"
              ><i /></button>
            </div>
          </div>

          <div class="set-grp">关于</div>
          <div class="set-card">
            <div class="set-row">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01" stroke-linecap="round"/></svg>
              <div class="set-lab"><b>AIUsageAtlas</b><i>版本 {{ APP_VERSION }} · Tauri 2 · {{ providers.length }} 渠道已接入</i></div>
            </div>
          </div>
        </div>
      </template>

      <!-- ================= 监控（分组布局） ================= -->
      <template v-else>
        <div class="stats num">
          <div class="st">
            <div class="st-label">今日费用</div>
            <div class="st-value">{{ summaryCost(data) }}</div>
          </div>
          <div class="st-div" />
          <div class="st">
            <div class="st-label">今日 Token</div>
            <div class="st-value">{{ summaryTokens(data) }}</div>
          </div>
          <div class="st-div" />
          <div class="st">
            <div class="st-label">数据截至</div>
            <div class="st-value st-time">{{ data ? relTime(data.generatedAt) : '—' }}</div>
          </div>
        </div>

        <div class="list thin-scroll">
          <div v-if="!providers.length" class="empty">
            <template v-if="loading">正在加载…</template>
            <template v-else>
              还没有接入渠道<br />
              <span class="empty-hint">打开 Web 仪表盘添加第一个供应商</span>
            </template>
          </div>

          <!-- 置顶：用户自选，展示全部额度窗口 + 余额 -->
          <template v-if="pinned.length">
            <div class="grp-h">
              <span class="grp-t">置顶</span>
              <span class="grp-n pin num">{{ pinned.length }}/{{ MAX_PINS }}</span>
            </div>
            <div v-for="p in pinned" :key="p.id" class="pv">
              <div class="pv-hd">
                <div class="pv-avatar" :style="avatarStyle(p.id, 26)">
                  <img v-if="avatarImg(p)" :src="avatarImg(p)" :alt="p.displayName" @error="markBroken(p)" />
                  <template v-else>{{ p.displayName.slice(0, 2).toUpperCase() }}</template>
                </div>
                <div class="pv-name">
                  <div class="pv-title">
                    {{ p.displayName }}
                    <i v-if="p.syncStatus === 'failed'" class="fail-dot" title="最近同步失败" />
                  </div>
                  <div class="pv-plan">
                    {{ p.plan.name }}
                    <template v-if="daysToRenewal(p.plan.renewalDate)"> · {{ daysToRenewal(p.plan.renewalDate)!.text }}</template>
                  </div>
                </div>
                <span v-if="p.balance" class="bal-chip num">余额 {{ fmtCost(p.balance.amount, p.balance.currency) }}</span>
                <button class="pinbtn on" :title="pinTitle(p)" @click="togglePin(p)">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                  </svg>
                </button>
              </div>

              <div v-for="w in p.windows" :key="w.name" class="q">
                <div class="q-top">
                  <span class="q-name">
                    {{ w.name }}
                    <b v-if="w.extraUsageEnabled" class="extra">超额</b>
                  </span>
                  <span class="q-pct num" :class="pctClass(w.usedPct)">{{ w.usedPct.toFixed(0) }}%</span>
                </div>
                <div class="q-bar">
                  <div class="q-fill" :style="{ width: Math.min(100, w.usedPct) + '%', background: pctColor(w.usedPct) }" />
                </div>
                <div class="q-sub num">
                  <span>{{ quotaValues(w) }}</span>
                  <span class="q-reset">{{ countdown(w.resetAt) }}</span>
                </div>
              </div>

              <div class="pv-foot num">
                <span>今日 {{ fmtTokens(p.today.tokens) }} · ≈{{ fmtCost(p.today.cost, p.today.currency) }}</span>
                <span class="sync" :class="{ bad: p.syncStatus === 'failed' }">
                  <i class="sync-dot" />{{ relTime(p.lastSyncAt) }}同步
                </span>
              </div>
            </div>
          </template>

          <!-- 其余：单行列表（含余额与置顶按钮），按最紧张程度降序 -->
          <template v-if="rest.length">
            <div class="grp-h" :class="{ first: !pinned.length }">
              <span class="grp-t">全部渠道</span>
              <span class="grp-n num">{{ rest.length }}</span>
            </div>
            <div class="rows">
              <div v-for="p in rest" :key="p.id" class="srow">
                <div class="pv-avatar sm" :style="avatarStyle(p.id, 18)">
                  <img v-if="avatarImg(p)" :src="avatarImg(p)" :alt="p.displayName" @error="markBroken(p)" />
                  <template v-else>{{ p.displayName.slice(0, 2).toUpperCase() }}</template>
                </div>
                <span class="srow-name">
                  {{ p.displayName }}
                  <i v-if="p.syncStatus === 'failed'" class="fail-dot" title="最近同步失败" />
                </span>
                <span v-if="p.balance" class="srow-bal num">{{ fmtCost(p.balance.amount, p.balance.currency) }}</span>
                <b class="num" :class="worstPct(p) >= 0 ? pctClass(worstPct(p)) : ''">{{ worstPct(p) >= 0 ? worstPct(p).toFixed(0) + '%' : '—' }}</b>
                <span class="srow-r num">{{ worstWindow(p) ? shortCountdown(worstWindow(p)!.resetAt) : '按量' }}</span>
                <button class="pinbtn" :title="pinTitle(p)" @click="togglePin(p)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                  </svg>
                </button>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.panel {
  padding: 20px;
  height: 100%;
}
/* 浏览器调试：页面内悬浮卡片 */
.panel.overlay {
  position: fixed;
  inset: 0;
  padding: 0;
  z-index: 40;
}
.panel.overlay .backdrop {
  position: absolute;
  inset: 0;
}
.panel.overlay .card {
  position: absolute;
  top: 120px;
  left: 24px;
}

.card {
  position: relative;
  width: 340px;
  height: 460px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  /* 阴影总伸展（偏移+模糊）必须 ≤ 窗口留白（20px），否则被方形窗口裁出灰边 */
  box-shadow:
    0 4px 12px rgba(38, 36, 31, 0.12),
    0 1px 3px rgba(38, 36, 31, 0.06);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: 50% 100%; /* 实际值由 :style 按球的方位覆盖 */
  animation: panel-in 260ms cubic-bezier(0.3, 1.25, 0.45, 1);
}
.card.closing {
  animation: panel-out 150ms ease-in forwards;
}

/* 进入：从球所在方向滑入（--enter-y 负=球在上方，正=球在下方），带回弹曲线 */
@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(var(--enter-y, 10px)) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
/* 收起：沿原方向缩回球的方位 */
@keyframes panel-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(calc(var(--enter-y, 10px) * 0.6)) scale(0.94);
  }
}

/* ---- 头部 ---- */
.hd {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 11px 12px 7px 14px;
}
.brand {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(244, 100, 60, 0.3);
}
.hd-title {
  flex: 1;
  font-size: 12.5px;
  font-weight: 720;
  letter-spacing: -0.2px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.hd-title-set {
  font-size: 13px;
  padding-left: 4px;
}
.hd-count {
  font-size: 10px;
  font-weight: 550;
  color: var(--text-faint);
}
.pill {
  border: none;
  background: var(--bg-sunken);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 620;
  border-radius: 9px;
  padding: 5px 9px;
  white-space: nowrap;
  transition:
    background 0.15s,
    color 0.15s;
}
.pill:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.ib {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition:
    background 0.15s,
    color 0.15s;
}
.ib:hover {
  background: var(--bg-sunken);
  color: var(--text);
}
.ib:disabled {
  opacity: 0.6;
  cursor: default;
}
.ib svg {
  width: 13.5px;
  height: 13.5px;
}
.ib-close:hover {
  background: var(--red-soft);
  color: var(--red);
}

/* ---- 错误条 ---- */
.err-banner {
  margin: 0 12px 6px;
  padding: 6px 10px;
  background: var(--red-soft);
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--red);
}
.err-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.retry {
  border: none;
  background: #fff;
  color: var(--red);
  font-size: 11px;
  font-weight: 620;
  border-radius: 7px;
  padding: 3px 9px;
}

/* ---- 三格汇总条 ---- */
.stats {
  display: flex;
  align-items: stretch;
  margin: 2px 14px 0;
  padding: 8px 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.st {
  flex: 1;
  min-width: 0;
  padding: 0 10px;
}
.st-div {
  width: 1px;
  background: var(--border);
  margin: 2px 0;
}
.st-label {
  font-size: 10px;
  color: var(--text-dim);
  font-weight: 550;
  letter-spacing: 0.2px;
}
.st-value {
  margin-top: 2px;
  font-size: 17px;
  font-weight: 780;
  letter-spacing: -0.4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-time {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-dim);
  padding-top: 2px;
}

/* ---- 列表与分组 ---- */
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.empty {
  text-align: center;
  padding: 44px 10px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.7;
}
.empty-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.grp-h {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.grp-h.first {
  margin-top: 0;
}
.grp-t {
  font-size: 11px;
  font-weight: 680;
  color: var(--text-dim);
}
.grp-n {
  font-size: 10px;
  font-weight: 650;
  color: var(--text-faint);
  background: var(--bg-sunken);
  border-radius: 10px;
  padding: 1px 7px;
}
.grp-n.bad {
  color: var(--red);
  background: var(--red-soft);
}
.grp-n.pin {
  color: var(--coral);
  background: #ffe9df;
}

/* 置顶卡片 */
.pv {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 9px 11px 8px;
  flex-shrink: 0;
}
.pv-hd {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pv-avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 720;
  overflow: hidden;
}
.pv-avatar.sm {
  border-radius: 6px !important;
}
.pv-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pv-name {
  flex: 1;
  min-width: 0;
}
.pv-title {
  font-size: 12px;
  font-weight: 680;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 5px;
}
.pv-plan {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.fail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--red);
  flex-shrink: 0;
  display: inline-block;
}
.pv-bigpct {
  font-size: 15px;
  font-weight: 780;
  margin-left: auto;
}
.pv-bigpct.good {
  color: var(--green);
}
.pv-bigpct.warn {
  color: var(--amber);
}
.pv-bigpct.danger {
  color: var(--red);
}

.q-bar {
  margin-top: 6px;
  height: 6px;
  background: var(--bg-sunken);
  border-radius: 6px;
  overflow: hidden;
}
.q-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.5s ease;
}
.q-sub {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 3px;
}
.q-reset {
  color: var(--text-dim);
}

/* 置顶卡：多窗口配额头行（名称+超额 / 百分比） */
.q-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  margin-top: 8px;
}
.q-name {
  color: var(--text-dim);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 5px;
}
.extra {
  font-size: 9px;
  font-weight: 650;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 6px;
  padding: 1px 5px;
}
.q-pct {
  font-weight: 720;
  font-size: 11px;
}
.q-pct.good {
  color: var(--green);
}
.q-pct.warn {
  color: var(--amber);
}
.q-pct.danger {
  color: var(--red);
}
.q-bar {
  margin-top: 4px;
}

/* 置顶卡底部：今日 + 同步状态 */
.pv-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}
.sync {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
}
.sync-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  flex-shrink: 0;
}
.sync.bad {
  color: var(--red);
}
.sync.bad .sync-dot {
  background: var(--red);
}

/* 余额显示 */
.bal-chip {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 620;
  color: var(--text-dim);
  background: var(--bg-sunken);
  border-radius: 20px;
  padding: 2.5px 7px;
}
.srow-bal {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-dim);
}

/* 置顶图钉按钮 */
.pinbtn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  border-radius: 7px;
  color: var(--text-faint);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition:
    background 0.15s,
    color 0.15s;
}
.pinbtn svg {
  width: 13px;
  height: 13px;
}
.pinbtn:hover {
  background: var(--bg-sunken);
  color: var(--coral);
}
.pinbtn.on {
  color: var(--coral);
}

/* 其余渠道单行 */
.rows {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 2px 9px;
  flex-shrink: 0;
}
.srow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5.5px 0;
  font-size: 11.5px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.srow:last-child {
  border-bottom: none;
}
.srow-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 5px;
}
.srow b {
  font-size: 11px;
  font-weight: 720;
}
.srow b.good {
  color: var(--green);
}
.srow b.warn {
  color: var(--amber);
}
.srow b.danger {
  color: var(--red);
}
.srow-r {
  font-size: 9.5px;
  color: var(--text-faint);
  width: 58px;
  text-align: right;
  flex-shrink: 0;
}

/* ---- 设置抽屉 ---- */
.set-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 4px 2px 2px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.set-grp {
  font-size: 10.5px;
  font-weight: 680;
  color: var(--text-faint);
  margin: 6px 2px 0;
  letter-spacing: 0.3px;
}
.set-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 2px 11px;
}
.set-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.set-row:last-child {
  border-bottom: none;
}
.set-row svg {
  width: 14px;
  height: 14px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.set-lab {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.set-lab b {
  font-size: 12px;
  font-weight: 650;
}
.set-lab i {
  font-size: 10px;
  color: var(--text-faint);
}
.set-row.ok {
  border-bottom: none;
  padding-top: 2px;
}
.set-row.ok svg {
  color: var(--green);
}
.set-row.ok span {
  font-size: 10.5px;
  color: var(--green);
  font-weight: 600;
}
.set-row.bad {
  border-bottom: none;
  padding-top: 2px;
}
.set-row.bad svg {
  color: var(--red);
}
.set-row.bad span {
  font-size: 10.5px;
  color: var(--red);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.set-input {
  width: 100%;
  box-sizing: border-box;
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 7px 9px;
  border: 1px solid var(--border-bright);
  border-radius: 9px;
  background: #fff;
  color: var(--text);
  outline: none;
  margin: 0 0 8px;
}
.set-input:focus {
  border-color: var(--accent);
}
.sw {
  width: 36px;
  height: 21px;
  border: none;
  border-radius: 20px;
  background: var(--border-bright);
  padding: 0;
  position: relative;
  flex-shrink: 0;
  transition: background 0.18s;
}
.sw i {
  position: absolute;
  top: 2.5px;
  left: 2.5px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(38, 36, 31, 0.25);
  transition: left 0.18s cubic-bezier(0.3, 0.9, 0.4, 1.1);
}
.sw.on {
  background: var(--green);
}
.sw.on i {
  left: 17.5px;
}
.sw:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
