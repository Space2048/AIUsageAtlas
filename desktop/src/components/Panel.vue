<script setup lang="ts">
// 展开面板：今日汇总 + 各渠道配额条/倒计时/续费/余额 + 手动同步。
// 原生模式是独立窗口（360x480），浏览器调试模式是页面内 overlay。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { DashboardData, ProviderVM } from '../../../shared/types'
import { useDashboard, getBase, setBase, iconUrl, openDashboard } from '../api'
import {
  fmtTokens,
  fmtCost,
  countdown,
  daysToRenewal,
  pctClass,
  pctColor,
  quotaValues,
  relTime,
  avatarStyle,
} from '../utils'

const props = defineProps<{ overlay: boolean }>()
const emit = defineEmits<{ close: [] }>()

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

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

function summaryCost(d: DashboardData | null): string {
  return d ? '¥' + d.summary.todayCostCny.toFixed(2) : '—'
}
function summaryTokens(d: DashboardData | null): string {
  return d ? fmtTokens(d.summary.todayTokens) : '—'
}
</script>

<template>
  <div class="panel" :class="{ overlay: props.overlay }">
    <div v-if="props.overlay" class="backdrop" @click="emit('close')" />
    <div class="card">
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

      <div class="stats">
        <div class="mini">
          <div class="mini-label">今日费用</div>
          <div class="mini-value num">{{ summaryCost(data) }}</div>
        </div>
        <div class="mini">
          <div class="mini-label">今日 Token</div>
          <div class="mini-value num">{{ summaryTokens(data) }}</div>
        </div>
      </div>

      <div class="meta num">
        数据截至 {{ data ? relTime(data.generatedAt) : '—' }}
        <span v-if="syncing" class="syncing-tag">· 同步中…</span>
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
            <span class="pv-sync" :class="{ bad: p.syncStatus === 'failed' }">
              {{ relTime(p.lastSyncAt) }}同步<template v-if="p.syncStatus === 'failed'"> · 失败</template>
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
  padding: 10px;
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
  top: 110px;
  left: 24px;
}

.card {
  position: relative;
  width: 340px;
  height: 460px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ---- 头部 ---- */
.hd {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 8px 14px;
}
.brand {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  box-shadow: 0 3px 8px rgba(244, 100, 60, 0.32);
}
.hd-title {
  flex: 1;
  font-size: 13px;
  font-weight: 720;
  letter-spacing: -0.2px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.hd-count {
  font-size: 10.5px;
  font-weight: 550;
  color: var(--text-faint);
}
.ib {
  width: 26px;
  height: 26px;
  border: none;
  background: var(--bg-sunken);
  border-radius: 9px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s;
}
.ib:hover {
  background: var(--border-bright);
  color: var(--text);
}
.ib:disabled {
  opacity: 0.6;
  cursor: default;
}
.ib svg {
  width: 14px;
  height: 14px;
}
.ib-close:hover {
  background: var(--red-soft);
  color: var(--red);
}

/* ---- 错误条 ---- */
.err-banner {
  margin: 0 12px 6px;
  padding: 7px 10px;
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

/* ---- 今日统计 ---- */
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 4px 14px 0;
}
.mini {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 9px 11px 10px;
}
.mini-label {
  font-size: 10.5px;
  color: var(--text-dim);
  font-weight: 550;
}
.mini-value {
  margin-top: 3px;
  font-size: 19px;
  font-weight: 780;
  letter-spacing: -0.5px;
}
.meta {
  padding: 7px 15px 2px;
  font-size: 10.5px;
  color: var(--text-faint);
}
.syncing-tag {
  color: var(--accent);
}

/* ---- 渠道列表 ---- */
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 14px 8px;
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
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.pv:last-child {
  border-bottom: none;
}
.pv-hd {
  display: flex;
  align-items: center;
  gap: 9px;
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
  font-size: 12.5px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pv-plan {
  font-size: 10.5px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.renew {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 620;
  color: var(--text-dim);
  background: var(--bg-sunken);
  border-radius: 20px;
  padding: 3px 8px;
}
.renew.urgent {
  color: var(--red);
  background: var(--red-soft);
}

/* ---- 配额条 ---- */
.q {
  margin-top: 9px;
}
.q-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}
.q-name {
  color: var(--text-dim);
  font-weight: 550;
  display: flex;
  align-items: center;
  gap: 5px;
}
.extra {
  font-size: 9.5px;
  font-weight: 650;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 6px;
  padding: 1px 5px;
}
.q-pct {
  font-weight: 720;
  font-size: 11.5px;
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
  height: 7px;
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
  font-size: 10.5px;
  color: var(--text-faint);
  margin-top: 4px;
}
.q-reset {
  color: var(--text-dim);
}

.pv-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10.5px;
  color: var(--text-dim);
  margin-top: 8px;
}
.pv-sync {
  color: var(--text-faint);
}
.pv-sync.bad {
  color: var(--red);
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

/* ---- 底部 ---- */
.ft {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 12px;
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
  font-size: 12.5px;
  font-weight: 650;
  border-radius: 12px;
  padding: 9px 10px;
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
  width: 14px;
  height: 14px;
}
.btn-link {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  font-weight: 550;
  padding: 6px 4px;
  white-space: nowrap;
}
.btn-link:hover {
  color: var(--accent);
}
</style>
