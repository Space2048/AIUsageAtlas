<script setup lang="ts">
// 展开面板：今日汇总 + 各渠道配额条/倒计时/续费/余额 + 手动同步。
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

const props = defineProps<{ overlay: boolean }>()
const emit = defineEmits<{ close: [] }>()

// 开/关动画：原生面板窗口是复用的（不重挂载），用 openKey 强制重挂载卡片让入场动画重放；
// 关闭时加 .closing 播完退场动画再由外层 hide 窗口。
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

// ---- 头像（渠道 logo 加载失败回退粉彩字模） ----
const broken = ref(new Set<string>())
function avatarImg(p: ProviderVM): string {
  if (!p.icon || broken.value.has(p.id)) return ''
  return iconUrl(p.icon)
}
function markBroken(p: ProviderVM) {
  broken.value.add(p.id)
}

// ---- 连接设置 ----
const showSettings = ref(false)
const draft = ref('')
function openSettings() {
  draft.value = getBase()
  showSettings.value = !showSettings.value
}
function saveSettings() {
  setBase(draft.value)
  showSettings.value = false
  load()
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

// 面板紧凑口径：超长整数换 B/K 缩写（6,570,269,648 → 6.57B），避免长串数字撑爆布局
function fmtQty(n: number): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K'
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)
}

// 配额窗口用量数字：采到才显示；上限 0/缺失时不显示「0 / 0」噪音
function quotaValues(w: QuotaWindow): string {
  const fmt = (n: number) => (w.unit === 'usd' ? fmtCost(n, 'USD') : fmtQty(n))
  if (w.limitValue !== null && w.limitValue > 0 && w.usedValue !== null)
    return `${fmt(w.usedValue)} / ${fmt(w.limitValue)}`
  if (w.usedValue !== null && w.usedValue > 0) return `已用 ${fmt(w.usedValue)}`
  return ''
}
</script>

<template>
  <div class="panel" :class="{ overlay: props.overlay }">
    <div v-if="props.overlay" class="backdrop" @click="emit('close')" />
    <div class="card" :class="{ closing }" :key="openKey">
      <header class="hd">
        <img class="brand" :src="`${getBase()}/icon.svg`" alt="" />
        <div class="hd-title">
          AIUsageAtlas
          <span class="hd-count num">{{ providers.length }} 渠道</span>
        </div>
        <button class="ib" title="同步全部" :disabled="syncing" @click="sync">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: syncing }">
            <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
          </svg>
        </button>
        <button class="ib" title="连接设置" @click="openSettings">
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
      </header>

      <div v-if="error" class="err-banner">
        <span class="err-text">服务未连接 — {{ error }}</span>
        <button class="retry" @click="load">重试</button>
      </div>

      <!-- 三格汇总条：费用 / Token / 数据时间，细分隔线，不占盒子 -->
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

        <div v-for="p in providers" :key="p.id" class="pv">
          <div class="pv-hd">
            <div class="pv-avatar" :style="avatarStyle(p.id, 26)">
              <img v-if="avatarImg(p)" :src="avatarImg(p)" :alt="p.displayName" @error="markBroken(p)" />
              <template v-else>{{ p.displayName.slice(0, 2).toUpperCase() }}</template>
            </div>
            <div class="pv-name">
              <div class="pv-title">{{ p.displayName }}</div>
              <div class="pv-plan">
                {{ p.plan.name }}
                <template v-if="p.balance"> · 余额 {{ fmtCost(p.balance.amount, p.balance.currency) }}</template>
              </div>
            </div>
            <span
              v-if="daysToRenewal(p.plan.renewalDate)"
              class="renew"
              :class="{ urgent: daysToRenewal(p.plan.renewalDate)!.urgent }"
            >{{ daysToRenewal(p.plan.renewalDate)!.text }}</span>
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
              <div
                class="q-fill"
                :style="{ width: Math.min(100, w.usedPct) + '%', background: pctColor(w.usedPct) }"
              />
            </div>
            <div class="q-sub num">
              <span>{{ quotaValues(w) }}</span>
              <span class="q-reset">{{ countdown(w.resetAt) }}</span>
            </div>
          </div>

          <div class="pv-foot num">
            <span>今日 {{ fmtTokens(p.today.tokens) }} · ≈{{ fmtCost(p.today.cost, p.today.currency) }}</span>
            <span class="sync" :class="{ bad: p.syncStatus === 'failed' }">
              <i class="sync-dot" />{{ relTime(p.lastSyncAt) }}同步<template v-if="p.syncStatus === 'failed'">失败</template>
            </span>
          </div>
        </div>
      </div>

      <div v-if="showSettings" class="settings">
        <input
          v-model="draft"
          class="settings-input"
          placeholder="http://127.0.0.1:3000"
          spellcheck="false"
          @keydown.enter="saveSettings"
        />
        <button class="btn-mini" @click="saveSettings">保存</button>
      </div>
      <div v-if="showSettings && isNative()" class="settings-row">
        <span class="settings-label">开机自启</span>
        <button
          class="switch"
          :class="{ on: autostartOn }"
          :disabled="autostartBusy"
          title="登录 Windows 后自动启动悬浮球"
          @click="toggleAutostart"
        >
          <i />
        </button>
      </div>

      <footer class="ft">
        <button class="btn-sync" :disabled="syncing" @click="sync">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" :class="{ spinning: syncing }">
            <path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round" />
          </svg>
          {{ syncing ? '同步中…' : '同步全部' }}
        </button>
        <button class="btn-link" @click="openDashboard">打开完整仪表盘 ↗</button>
      </footer>
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
  /* 阴影总伸展（偏移+模糊）必须 ≤ 窗口留白（20px），否则被方形窗口裁出灰边（与悬浮球同坑） */
  box-shadow:
    0 4px 12px rgba(38, 36, 31, 0.12),
    0 1px 3px rgba(38, 36, 31, 0.06);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: 30% 100%; /* 靠近球的一角为锚点展开/收起 */
  animation: panel-in 220ms cubic-bezier(0.22, 0.9, 0.3, 1);
}
.card.closing {
  animation: panel-out 150ms ease-in forwards;
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes panel-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(8px) scale(0.95);
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
.hd-count {
  font-size: 10px;
  font-weight: 550;
  color: var(--text-faint);
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

/* ---- 渠道列表（独立小卡片） ---- */
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
}
.pv-plan {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.renew {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 620;
  color: var(--text-dim);
  background: var(--bg-sunken);
  border-radius: 20px;
  padding: 2.5px 7px;
}
.renew.urgent {
  color: var(--red);
  background: var(--red-soft);
}

/* ---- 配额条（紧凑：名称+百分比一行，进度条，数字+倒计时一行） ---- */
.q {
  margin-top: 8px;
}
.q-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
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
  margin-top: 3px;
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

/* ---- 连接设置 ---- */
.settings {
  display: flex;
  gap: 6px;
  padding: 8px 14px 0;
}
.settings-input {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 6px 9px;
  border: 1px solid var(--border-bright);
  border-radius: 9px;
  background: var(--bg-elevated);
  color: var(--text);
  outline: none;
}
.settings-input:focus {
  border-color: var(--accent);
}
.btn-mini {
  border: none;
  background: var(--ink);
  color: #fff;
  font-size: 11.5px;
  font-weight: 620;
  border-radius: 9px;
  padding: 0 12px;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 0;
}
.settings-label {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 550;
}
.switch {
  position: relative;
  width: 36px;
  height: 21px;
  border: none;
  border-radius: 20px;
  background: var(--border-bright);
  padding: 0;
  transition: background 0.18s;
}
.switch i {
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
.switch.on {
  background: var(--green);
}
.switch.on i {
  left: 17.5px;
}
.switch:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ---- 底部 ---- */
.ft {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px 11px;
  border-top: 1px solid var(--border);
}
.btn-sync {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  background: var(--ink);
  color: #fff;
  font-size: 12px;
  font-weight: 650;
  border-radius: 11px;
  padding: 8px 10px;
  transition:
    transform 0.12s,
    opacity 0.15s;
}
.btn-sync:hover {
  transform: translateY(-1px);
}
.btn-sync:disabled {
  opacity: 0.62;
  transform: none;
  cursor: default;
}
.btn-sync svg {
  width: 13px;
  height: 13px;
}
.btn-link {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 550;
  padding: 6px 4px;
  white-space: nowrap;
}
.btn-link:hover {
  color: var(--accent);
}
</style>
