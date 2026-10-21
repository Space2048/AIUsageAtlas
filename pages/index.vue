<script setup lang="ts">
import type { DashboardData, PluginMeta, ProviderVM } from '~~/shared/types'

useHead({ title: 'AIUsageAtlas — AI 用量聚合' })

const data = ref<DashboardData | null>(null)
const plugins = ref<PluginMeta[]>([])
const loading = ref(true)
const showAddModal = ref(false)
const syncingAll = ref(false)
const syncingId = ref<string | null>(null)
const toast = ref('')

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  data.value = await $fetch<DashboardData>('/api/dashboard')
  loading.value = false
}

async function loadPlugins() {
  plugins.value = await $fetch<PluginMeta[]>('/api/plugins')
}

async function syncAll() {
  syncingAll.value = true
  await $fetch('/api/sync', { method: 'POST' })
  await load()
  syncingAll.value = false
  showToast(`已同步 ${data.value?.summary.activeProviders ?? 0} 个供应商`)
}

async function syncOne(p: ProviderVM) {
  syncingId.value = p.id
  await $fetch('/api/sync', { method: 'POST', body: { providerId: p.id } })
  await load()
  syncingId.value = null
  showToast(`${p.displayName} 已刷新`)
}

function showToast(msg: string) {
  toast.value = msg
  setTimeout(() => (toast.value = ''), 2200)
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function fmtCost(n: number, cur: string): string {
  const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : cur + ' '
  return sym + n.toFixed(2)
}

function countdown(iso: string | null): string {
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

function daysToRenewal(dateStr: string | null): { text: string; urgent: boolean } | null {
  if (!dateStr) return null
  const diff = new Date(dateStr + 'T00:00:00').getTime() - now.value
  const days = Math.ceil(diff / 86400_000)
  if (days < 0) return { text: '已过期', urgent: true }
  if (days === 0) return { text: '今日续费', urgent: true }
  return { text: `${days}天后续费`, urgent: days <= 3 }
}

function pctClass(p: number): string {
  if (p >= 85) return 'danger'
  if (p >= 60) return 'warn'
  return 'good'
}

function pctColor(p: number): string {
  if (p >= 85) return '#e8594f'
  if (p >= 60) return '#e0952a'
  return '#2fa36b'
}

// 配额窗口的真实用量数字：采到才显示，口径随 unit（credits 千分位整数，usd 货币符号）；
// 上限为 0/缺失说明该额度桶没分配额度，不显示「0 / 0」这种噪音
function quotaValues(w: { usedValue: number | null; limitValue: number | null; unit: string }): string {
  const fmt = (n: number) => (w.unit === 'usd' ? fmtCost(n, 'USD') : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2))
  if (w.limitValue !== null && w.limitValue > 0 && w.usedValue !== null) return `${fmt(w.usedValue)} / ${fmt(w.limitValue)}`
  if (w.usedValue !== null && w.usedValue > 0) return `已用 ${fmt(w.usedValue)}`
  return ''
}

function maxHistory(p: ProviderVM): number {
  return Math.max(1, ...p.history.map((h) => h.tokens))
}

function authKindLabel(k: string): string {
  return k === 'apikey' ? 'API Key' : k === 'cookie' ? 'Cookie' : '浏览器登录'
}

function relTime(iso: string): string {
  const diff = Math.max(0, now.value - new Date(iso).getTime())
  const m = Math.floor(diff / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return `${h} 小时前`
}

// 添加供应商弹窗
const selectedPlugin = ref<string>('')
const authKind = ref<string>('apikey')
const authValue = ref('')
const displayName = ref('')
const guideSaving = ref(false)
const guideResult = ref<{ ok: boolean; message: string } | null>(null)

const selectedPluginMeta = computed(() => plugins.value.find((p) => p.id === selectedPlugin.value))

watch(selectedPlugin, (id) => {
  const meta = plugins.value.find((p) => p.id === id)
  authKind.value = meta?.authKinds[0] ?? 'apikey'
  guideResult.value = null
})

async function addProvider() {
  if (!selectedPlugin.value) return
  guideSaving.value = true
  try {
    const res = await $fetch<{ id: string }>('/api/providers', {
      method: 'POST',
      body: {
        pluginId: selectedPlugin.value,
        authKind: authKind.value,
        authValue: authValue.value,
        displayName: displayName.value.trim() || undefined,
      },
    })
    // Cookie 模式：立即同步一次，把验证结果反馈给用户
    if (authKind.value === 'cookie') {
      const sync = await $fetch<{ results: Array<{ ok: boolean; mode: string; error?: string }> }>('/api/sync', {
        method: 'POST',
        body: { providerId: res.id },
      })
      const r = sync.results[0]
      if (r?.ok) {
        showToast('Cookie 验证成功，已开始采集数据')
        showAddModal.value = false
        authValue.value = ''
        await load()
      } else {
        guideResult.value = { ok: false, message: r?.error || '同步失败，请检查 Cookie 是否完整、是否已过期' }
      }
    } else {
      showAddModal.value = false
      authValue.value = ''
      await load()
      showToast('供应商已添加，正在后台同步')
    }
  } finally {
    guideSaving.value = false
  }
}

function submitCookie(value: string) {
  authValue.value = value
  guideResult.value = null
  addProvider()
}

// 浏览器登录模式：先建档 → 调登录接口（弹出真实浏览器）→ 等待结果
async function startBrowserLogin() {
  if (!selectedPlugin.value) return
  guideSaving.value = true
  guideResult.value = null
  try {
    const res = await $fetch<{ id: string }>('/api/providers', {
      method: 'POST',
      body: {
        pluginId: selectedPlugin.value,
        authKind: 'browser-login',
        displayName: displayName.value.trim() || undefined,
      },
    })
    const login = await $fetch<{ ok: boolean; message: string }>(`/api/providers/${res.id}/login`, {
      method: 'POST',
      timeout: 200_000,
    })
    if (login.ok) {
      showToast('登录成功，会话已保持')
      showAddModal.value = false
      await load()
    } else {
      guideResult.value = { ok: false, message: `${login.message}，可重试或改用粘贴 Cookie` }
    }
  } catch (e) {
    guideResult.value = { ok: false, message: (e as Error).message }
  } finally {
    guideSaving.value = false
  }
}

async function openAdd() {
  showAddModal.value = true
  guideResult.value = null
  displayName.value = ''
  await loadPlugins()
  selectedPlugin.value = plugins.value[0]?.id ?? ''
  authKind.value = plugins.value[0]?.authKinds[0] ?? 'apikey'
}

onMounted(async () => {
  await Promise.all([load(), loadPlugins()])
  timer = setInterval(() => (now.value = Date.now()), 1000)
  // 页面重新可见时刷新数据（避免显示陈旧数据）
  document.addEventListener('visibilitychange', onVisible)
})

function onVisible() {
  if (document.visibilityState === 'visible') load()
}

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <div>
    <AppHeader>
      <button class="btn" :disabled="syncingAll" @click="syncAll">
        <svg v-if="syncingAll" class="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>
        {{ syncingAll ? '同步中…' : '同步全部' }}
      </button>
      <button class="btn btn-primary" @click="openAdd">+ 添加供应商</button>
    </AppHeader>

    <main class="container">
      <div v-if="loading" class="loading">正在加载…</div>
      <template v-else-if="data">
        <div class="summary-row">
          <div class="stat-card">
            <div class="stat-label">今日 Token 消耗</div>
            <div class="stat-value">{{ fmtTokens(data.summary.todayTokens) }}</div>
            <div class="stat-hint">全渠道合计（估算）</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">今日费用（折算）</div>
            <div class="stat-value">¥{{ data.summary.todayCostCny.toFixed(2) }}</div>
            <div class="stat-hint">按 LiteLLM 价格表估算</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">已接入供应商</div>
            <div class="stat-value">{{ data.summary.activeProviders }}</div>
            <div class="stat-hint">订阅 {{ data.providers.filter(p => p.category === 'subscription').length }} · API {{ data.providers.filter(p => p.category !== 'subscription').length }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">30 天内续费</div>
            <div class="stat-value">{{ data.summary.renewalsThisMonth }}</div>
            <div class="stat-hint">活跃告警 {{ data.summary.alerts }} 条</div>
          </div>
        </div>

        <div class="section-head">
          <span class="section-title">供应商</span>
          <span class="section-count">共 {{ data.providers.length }} 个</span>
        </div>

        <div v-if="!data.providers.length" class="empty-state">
          还没有供应商，点击右上角「添加供应商」接入第一个渠道
        </div>

        <div class="provider-grid">
          <NuxtLink v-for="p in data.providers" :key="p.id" :to="`/providers/${p.id}`" class="provider-card">
            <div class="pc-head">
              <ProviderIcon :icon="p.icon" :seed="p.id" :name="p.displayName" :text="p.displayName.slice(0, 2).toUpperCase()" />
              <div class="pc-title">
                <div class="pc-name">{{ p.displayName }}</div>
                <div class="pc-account">{{ p.account.userName }}<template v-if="p.account.maskedContact"> · {{ p.account.maskedContact }}</template></div>
              </div>
            </div>

            <div class="pc-plan">
              <div class="pc-plan-info">
                <div class="pc-plan-name">{{ p.plan.name }}</div>
                <div class="pc-plan-meta">
                  <span v-if="(p.plan.unknownFields ?? []).includes('price')" class="unknown-val">价格未获取到</span>
                  <template v-else-if="p.plan.price > 0">{{ p.plan.currency === 'USD' ? '$' : '¥' }}{{ p.plan.price }}<b>/期</b></template>
                  <template v-else>免费/按量</template>
                  <span v-if="p.plan.autoRenew"> · 自动续费</span>
                </div>
              </div>
              <span v-if="daysToRenewal(p.plan.renewalDate)" class="renew-tag" :class="{ urgent: daysToRenewal(p.plan.renewalDate)!.urgent }">
                {{ daysToRenewal(p.plan.renewalDate)!.text }}
              </span>
              <span v-if="p.balance" class="balance-chip">余额 {{ fmtCost(p.balance.amount, p.balance.currency) }}</span>
            </div>

            <div class="quota-block">
              <template v-if="p.windows.length">
                <div v-for="w in p.windows" :key="w.name">
                  <div class="quota-row-header">
                    <span class="quota-name">
                      {{ w.name }}
                      <span v-if="w.extraUsageEnabled" class="extra-tag">超额可用</span>
                    </span>
                    <span class="quota-pct" :class="pctClass(w.usedPct)">{{ w.usedPct.toFixed(0) }}%</span>
                  </div>
                  <div class="quota-bar">
                    <div class="quota-bar-fill" :style="{ width: Math.min(100, w.usedPct) + '%', background: pctColor(w.usedPct) }" />
                  </div>
                  <div class="quota-sub">
                    <span class="quota-values">{{ quotaValues(w) }}</span>
                    <span class="quota-reset">{{ countdown(w.resetAt) }}</span>
                  </div>
                </div>
              </template>
              <div v-else class="quota-empty">该渠道 API 未提供配额窗口数据</div>
            </div>

            <div class="spark" :title="'近7日用量趋势'">
              <div v-for="h in p.history" :key="h.date" class="spark-bar" :class="{ today: h === p.history.at(-1) }" :style="{ height: Math.max(4, (h.tokens / maxHistory(p)) * 100) + '%' }" />
            </div>

            <div class="pc-foot">
              <div class="pc-today">
                今日 <b>{{ fmtTokens(p.today.tokens) }}</b>
                <span class="cost"> · ≈ {{ fmtCost(p.today.cost, p.today.currency) }}</span>
                <div style="font-size:10.5px;color:var(--text-faint);margin-top:2px">{{ relTime(p.lastSyncAt) }}同步 · {{ p.syncStatus === 'ok' ? '正常' : '失败' }}</div>
              </div>
              <button class="icon-btn" :class="{ spinning: syncingId === p.id }" title="立即刷新" @click.prevent="syncOne(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>
              </button>
            </div>
          </NuxtLink>
        </div>
      </template>

      <div v-if="showAddModal" class="modal-overlay" @click.self="showAddModal = false">
        <div class="modal">
          <h3 class="modal-title">添加供应商</h3>
          <p class="modal-desc">选择渠道并配置登录方式，添加后按默认间隔自动同步（可在卡片上手动刷新）。</p>

          <div class="field">
            <label class="field-label" for="channel-select">渠道</label>
            <div class="channel-select">
              <ProviderIcon
                v-if="selectedPluginMeta"
                class="cs-icon"
                :icon="selectedPluginMeta.icon"
                :seed="selectedPluginMeta.id"
                :name="selectedPluginMeta.displayName"
                :text="selectedPluginMeta.displayName.slice(0, 2)"
                :size="26"
              />
              <select id="channel-select" v-model="selectedPlugin" class="field-input">
                <option v-for="pl in plugins" :key="pl.id" :value="pl.id">{{ pl.displayName }}</option>
              </select>
              <svg class="cs-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <div v-if="selectedPluginMeta" class="field-hint">
              {{ selectedPluginMeta.homepage }} · 支持 {{ selectedPluginMeta.authKinds.map(authKindLabel).join(' / ') }}
            </div>
          </div>

          <div class="field">
            <label class="field-label">显示名称（可选）</label>
            <input v-model="displayName" class="field-input" placeholder="留空使用渠道默认名；多账号可设为「StepFun 个人」「StepFun 公司」" />
          </div>

          <template v-if="authKind === 'cookie' && selectedPluginMeta?.cookieGuide">
            <CookieGuide
              :guide="selectedPluginMeta.cookieGuide"
              :saving="guideSaving"
              :result="guideResult"
              :supports-browser-login="selectedPluginMeta.authKinds.includes('browser-login')"
              @submit="submitCookie"
              @browser-login="startBrowserLogin"
              @cancel="showAddModal = false"
            />
          </template>
          <template v-else-if="authKind === 'browser-login' && selectedPluginMeta?.cookieGuide">
            <CookieGuide
              :guide="selectedPluginMeta.cookieGuide"
              :saving="guideSaving"
              :result="guideResult"
              :supports-browser-login="true"
              @browser-login="startBrowserLogin"
              @cancel="showAddModal = false"
            />
          </template>
          <template v-else>
            <div class="field">
              <label class="field-label">登录方式</label>
            <div class="form-row" style="gap:8px;margin-bottom:4px">
              <button
                v-for="k in (selectedPluginMeta?.authKinds || [])"
                :key="k"
                class="filter-chip"
                :class="{ active: authKind === k }"
                @click="authKind = k"
              >{{ authKindLabel(k) }}</button>
            </div>
            <div class="field-hint">浏览器登录会弹出真实浏览器，登录一次后会话长期复用；Cookie 约一天过期。</div>
          </div>

          <div class="field">
            <label class="field-label">凭证（API Key / Cookie）</label>
            <input v-model="authValue" class="field-input" :placeholder="authKind === 'apikey' ? 'sk-...' : '从浏览器开发者工具复制完整 Cookie'" />
          </div>

            <div class="modal-actions">
              <button class="btn" @click="showAddModal = false">取消</button>
              <button class="btn btn-primary" :disabled="!selectedPlugin" @click="addProvider">添加</button>
            </div>
          </template>
        </div>
      </div>

      <div v-if="toast" class="toast"><span class="toast-dot" />{{ toast }}</div>
    </main>
  </div>
</template>
