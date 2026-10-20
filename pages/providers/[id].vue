<script setup lang="ts">
import type { ProviderDetail } from '~~/shared/types'

const route = useRoute()
const id = route.params.id as string

const { data: detail, refresh } = await useFetch<ProviderDetail>(`/api/providers/${id}`, { key: `provider-${id}` })

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
function onVisible() {
  if (document.visibilityState === 'visible') refresh()
}
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})

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
  if (d > 0) return `${d}天${h}小时后重置`
  if (h > 0) return `${h}小时${m}分后重置`
  return `${m}分${s0(diff)}秒后重置`
}
function s0(diff: number) { return Math.floor((diff % 60_000) / 1000) }

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

function categoryLabel(c: string): string {
  return c === 'subscription' ? '订阅' : c === 'api' ? 'API' : '聚合'
}
function categoryBadge(c: string): string {
  return c === 'subscription' ? 'badge-sub' : c === 'api' ? 'badge-api' : 'badge-agg'
}

// 30 日图
const maxUsage = computed(() => Math.max(1, ...(detail.value?.usage30d.map((u) => u.tokens) ?? [])))
const monthTokens = computed(() => (detail.value?.usage30d.reduce((a, u) => a + u.tokens, 0) ?? 0))
const monthCost = computed(() =>
  (detail.value?.usage30d.reduce((a, u) => a + (u.currency === 'USD' ? u.costAmount * 7.1 : u.costAmount), 0) ?? 0)
)

// 同步配置编辑
const intervalMin = ref(60)
const savingSync = ref(false)
watch(detail, (d) => { if (d) intervalMin.value = Math.round(d.sync.intervalSec / 60) })
async function saveSync() {
  savingSync.value = true
  await $fetch(`/api/providers/${id}`, { method: 'PATCH', body: { intervalSec: intervalMin.value * 60 } })
  await refresh()
  savingSync.value = false
}
async function toggleEnabled() {
  const next = !(detail.value?.sync.enabled ?? true)
  await $fetch(`/api/providers/${id}`, { method: 'PATCH', body: { enabled: next } })
  await refresh()
}

// 手动刷新
const syncing = ref(false)
async function syncNow() {
  syncing.value = true
  await $fetch('/api/sync', { method: 'POST', body: { providerId: id } })
  await refresh()
  syncing.value = false
}

// 重命名（多账号区分）
const renameValue = ref('')
const renaming = ref(false)
watch(detail, (d) => { if (d) renameValue.value = d.displayName }, { immediate: true })
async function saveRename() {
  const v = renameValue.value.trim()
  if (!v) return
  renaming.value = true
  await $fetch(`/api/providers/${id}`, { method: 'PATCH', body: { displayName: v } })
  await refresh()
  renaming.value = false
}

// 删除（两步确认）
const confirmingDelete = ref(false)
async function remove() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    setTimeout(() => (confirmingDelete.value = false), 4000)
    return
  }
  await $fetch(`/api/providers/${id}`, { method: 'DELETE' })
  navigateTo('/')
}

// 更新凭证（Cookie 过期重新引导 / 换 API Key）
const plugins = ref<Array<{ id: string; authKinds: string[]; cookieGuide?: { loginUrl: string; steps: string[] } }>>([])
const showCredModal = ref(false)
const credKind = ref('cookie')
const credValue = ref('')
const credSaving = ref(false)
const credResult = ref<{ ok: boolean; message: string } | null>(null)

const pluginMeta = computed(() => plugins.value.find((p) => p.id === detail.value?.pluginId))

onMounted(async () => {
  plugins.value = await $fetch('/api/plugins')
})

function openCredModal() {
  // 默认选中当前已配置的凭证类型；未配置则优先浏览器登录
  credKind.value = detail.value?.credential.kind || (pluginMeta.value?.authKinds.includes('browser-login') ? 'browser-login' : pluginMeta.value?.authKinds[0] || 'cookie')
  credValue.value = ''
  credResult.value = null
  showCredModal.value = true
}

async function submitCredential(value: string) {
  credSaving.value = true
  credResult.value = null
  try {
    const res = await $fetch<{ ok: boolean; mode: string; error?: string }>(`/api/providers/${id}/credential`, {
      method: 'POST',
      body: { kind: credKind.value, value },
    })
    if (res.ok) {
      credResult.value = { ok: true, message: '凭证验证成功，数据已更新' }
      await refresh()
      setTimeout(() => (showCredModal.value = false), 1200)
    } else {
      credResult.value = { ok: false, message: res.error || '验证失败，请检查凭证' }
    }
  } catch (e) {
    credResult.value = { ok: false, message: (e as Error).message }
  } finally {
    credSaving.value = false
  }
}

// 浏览器登录（持久会话）
async function startBrowserLogin() {
  credSaving.value = true
  credResult.value = null
  try {
    const login = await $fetch<{ ok: boolean; message: string }>(`/api/providers/${id}/login`, {
      method: 'POST',
      timeout: 200_000,
    })
    if (login.ok) {
      // 登录成功后建立 browser-login 凭证，之后同步走持久会话
      await $fetch(`/api/providers/${id}/credential`, {
        method: 'POST',
        body: { kind: 'browser-login', value: 'logged-in' },
      }).catch(() => {})
      credResult.value = { ok: true, message: '登录成功，会话已保持' }
      await refresh()
      setTimeout(() => (showCredModal.value = false), 1200)
    } else {
      credResult.value = { ok: false, message: `${login.message}，可重试` }
    }
  } catch (e) {
    credResult.value = { ok: false, message: (e as Error).message }
  } finally {
    credSaving.value = false
  }
}

useHead({ title: () => (detail.value ? `${detail.value.displayName} — AIUsageAtlas` : 'AIUsageAtlas') })
</script>

<template>
  <div v-if="detail">
    <AppHeader>
      <button class="btn" :disabled="syncing" @click="syncNow">
        <svg :class="{ spinning: syncing }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>
        {{ syncing ? '同步中…' : '立即同步' }}
      </button>
    </AppHeader>

    <main class="container">
      <div class="page-head">
        <NuxtLink to="/" class="back-link" title="返回仪表盘">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </NuxtLink>
        <ProviderIcon :icon="detail.icon" :seed="detail.id" :name="detail.displayName" :text="detail.displayName.slice(0, 2).toUpperCase()" :size="48" />
        <div>
          <div class="page-title">
            {{ detail.displayName }}
            <span class="badge" :class="categoryBadge(detail.category)">{{ categoryLabel(detail.category) }}</span>
          </div>
          <div class="page-sub">{{ detail.account.userName }}<template v-if="detail.account.maskedContact"> · {{ detail.account.maskedContact }}</template></div>
        </div>
        <div class="page-actions">
          <button class="btn" @click="openCredModal">更新凭证</button>
          <button class="btn" :class="{ 'btn-danger': !confirmingDelete, confirming: confirmingDelete }" @click="remove">
            {{ confirmingDelete ? '再点一次确认删除' : '删除供应商' }}
          </button>
        </div>
      </div>

      <div class="detail-grid">
        <!-- 账户与计划 -->
        <div class="panel">
          <div class="panel-title">账户与计划</div>
          <div class="info-rows">
            <div class="info-row">
              <span class="k">显示名称</span>
              <span class="form-row">
                <input v-model="renameValue" class="field-input" style="width:180px" placeholder="如 StepFun 个人" />
                <button class="btn" :disabled="renaming || !renameValue.trim()" @click="saveRename">{{ renaming ? '保存中' : '保存' }}</button>
              </span>
            </div>
            <div class="info-row"><span class="k">当前计划</span><span class="v">{{ detail.plan.name }}</span></div>
            <div class="info-row"><span class="k">计划价格</span><span class="v">{{ detail.plan.price > 0 ? fmtCost(detail.plan.price, detail.plan.currency) + ' / 期' : '免费/按量' }}</span></div>
            <div class="info-row"><span class="k">续费日期</span><span class="v">
              {{ detail.plan.renewalDate ?? '—' }}
              <span v-if="daysToRenewal(detail.plan.renewalDate)" class="renew-tag" :class="{ urgent: daysToRenewal(detail.plan.renewalDate)!.urgent }" style="margin-left:8px">{{ daysToRenewal(detail.plan.renewalDate)!.text }}</span>
            </span></div>
            <div class="info-row"><span class="k">自动续费</span><span class="v">{{ detail.plan.autoRenew ? '已开启' : '未开启' }}</span></div>
            <div class="info-row"><span class="k">账户余额</span><span class="v">{{ detail.balance ? fmtCost(detail.balance.amount, detail.balance.currency) : '—' }}</span></div>
            <div class="info-row"><span class="k">账户地区</span><span class="v">{{ detail.account.region || '—' }}</span></div>
            <div class="info-row"><span class="k">登录方式</span><span class="v">{{ detail.authKinds.join(' / ') }}</span></div>
          </div>
        </div>

        <!-- 额度窗口 -->
        <div class="panel">
          <div class="panel-title">配额窗口</div>
          <div class="quota-block">
            <template v-if="detail.windows.length">
              <div v-for="w in detail.windows" :key="w.name">
                <div class="quota-row-header">
                  <span class="quota-name">
                    {{ w.name }}
                    <span v-if="w.extraUsageEnabled" class="extra-tag">超额可用</span>
                  </span>
                  <span class="quota-pct" :class="pctClass(w.usedPct)">{{ w.usedPct.toFixed(0) }}%</span>
                </div>
                <div class="quota-bar"><div class="quota-bar-fill" :style="{ width: Math.min(100, w.usedPct) + '%', background: pctColor(w.usedPct) }" /></div>
                <div class="quota-reset">{{ countdown(w.resetAt) }}</div>
              </div>
            </template>
            <div v-else class="quota-empty">官方 API 不提供额度窗口，配置 Cookie 后可通过控制台采集补全</div>
          </div>
        </div>

        <!-- 30 日用量 -->
        <div v-if="detail.usage30d.length" class="panel full">
          <div class="panel-title">
            近 30 日用量 <span class="count">共 {{ fmtTokens(monthTokens) }} tokens · 约 ¥{{ monthCost.toFixed(2) }}</span>
          </div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#f4643c" />今日</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#f1eee7" />历史</span>
          </div>
          <div class="chart-30">
            <div
              v-for="u in detail.usage30d"
              :key="u.date"
              class="chart-col"
              :class="{ today: u === detail.usage30d.at(-1) }"
              :style="{ height: Math.max(3, (u.tokens / maxUsage) * 100) + '%' }"
              :title="`${u.date}: ${fmtTokens(u.tokens)} tokens · ${fmtCost(u.costAmount, u.currency)}`"
            />
          </div>
          <div class="chart-labels">
            <span>{{ detail.usage30d[0]?.date ?? '' }}</span>
            <span>{{ detail.usage30d.at(-1)?.date ?? '' }}</span>
          </div>
        </div>
        <div v-else class="panel full">
          <div class="panel-title">近 30 日用量</div>
          <div class="quota-empty">官方 API 不提供历史用量明细，控制台采集（Cookie）可补全</div>
        </div>

        <!-- 模型明细 -->
        <div class="panel full">
          <div class="panel-title">模型用量明细 <span class="count">按累计 tokens</span></div>
          <table class="model-table">
            <thead>
              <tr>
                <th>模型</th><th>占比</th><th class="num">Tokens</th><th class="num">请求数</th><th class="num">输入价 /M</th><th class="num">输出价 /M</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in detail.modelUsage" :key="m.modelId">
                <td class="model-name">{{ m.modelId }}</td>
                <td>
                  <div class="model-share">
                    <div class="model-share-bar"><div class="model-share-fill" :style="{ width: m.sharePct + '%' }" /></div>
                    <span class="num muted" style="min-width:38px">{{ m.sharePct.toFixed(1) }}%</span>
                  </div>
                </td>
                <td class="num">{{ fmtTokens(m.tokens) }}</td>
                <td class="num muted">{{ m.requests.toLocaleString() }}</td>
                <td class="num muted">{{ m.inputPerM !== null ? fmtCost(m.inputPerM, m.currency || 'USD') : '—' }}</td>
                <td class="num muted">{{ m.outputPerM !== null ? fmtCost(m.outputPerM, m.currency || 'USD') : '—' }}</td>
              </tr>
              <tr v-if="!detail.modelUsage.length"><td colspan="6" class="muted" style="text-align:center;padding:20px">暂无模型明细（官方 API 不提供，控制台采集可补全）</td></tr>
            </tbody>
          </table>
        </div>

        <!-- 同步配置 -->
        <div class="panel">
          <div class="panel-title">同步配置</div>
          <div class="info-rows">
            <div class="info-row">
              <span class="k">启用自动同步</span>
              <button class="switch" :class="{ on: detail.sync.enabled }" @click="toggleEnabled" />
            </div>
            <div class="info-row">
              <span class="k">同步间隔</span>
              <span class="form-row">
                <span class="input-group">
                  <input v-model.number="intervalMin" class="field-input" type="number" min="5" step="5" />
                  <span class="input-suffix">分钟</span>
                </span>
                <button class="btn" :disabled="savingSync" @click="saveSync">{{ savingSync ? '保存中…' : '保存' }}</button>
              </span>
            </div>
            <div class="info-row"><span class="k">取数方式</span><span class="v">{{ detail.authKinds.join(' / ') }}</span></div>
            <div class="info-row">
              <span class="k">凭证状态</span>
              <span class="v">
                <span v-if="detail.credential.configured" class="badge badge-api">已配置 {{ detail.credential.kind }}</span>
                <span v-else class="badge" style="background:var(--red-soft);color:var(--red)">未配置（当前为模拟数据）</span>
              </span>
            </div>
          </div>
          <div class="field-hint" style="margin-top:12px">最小 5 分钟。间隔过短可能触发供应商风控，建议 ≥ 10 分钟。</div>
        </div>

        <!-- 同步日志 -->
        <div class="panel">
          <div class="panel-title">同步日志 <span class="count">最近 5 次</span></div>
          <div class="log-list">
            <div v-for="l in detail.syncLogs" :key="l.id" class="log-item">
              <span class="log-dot" :class="l.status" />
              <span class="log-time">{{ l.startedAt.replace('T', ' ').slice(5, 16) }}</span>
              <span class="log-msg">
                <template v-if="l.status === 'ok'">同步成功</template>
                <template v-else><span class="err">{{ l.errorMsg || '同步失败' }}</span></template>
              </span>
              <span class="log-dur">{{ (l.durationMs / 1000).toFixed(1) }}s</span>
            </div>
            <div v-if="!detail.syncLogs.length" class="muted">暂无日志</div>
          </div>
        </div>
      </div>
    </main>

    <div v-if="showCredModal" class="modal-overlay" @click.self="showCredModal = false">
      <div class="modal">
        <template v-if="credKind === 'cookie' && pluginMeta?.cookieGuide">
          <CookieGuide
            :guide="pluginMeta.cookieGuide"
            :saving="credSaving"
            :result="credResult"
            :supports-browser-login="(pluginMeta?.authKinds || []).includes('browser-login')"
            @submit="submitCredential"
            @browser-login="startBrowserLogin"
            @cancel="showCredModal = false"
          />
        </template>
        <template v-else-if="credKind === 'browser-login' && pluginMeta?.cookieGuide">
          <CookieGuide
            :guide="pluginMeta.cookieGuide"
            :saving="credSaving"
            :result="credResult"
            :supports-browser-login="true"
            @browser-login="startBrowserLogin"
            @cancel="showCredModal = false"
          />
        </template>
        <template v-else>
          <h3 class="modal-title">更新凭证</h3>
          <p class="modal-desc">更新后立即同步一次验证凭证有效性。</p>
          <div class="form-row" style="gap:8px;margin-bottom:16px">
            <button
              v-for="k in (pluginMeta?.authKinds || [])"
              :key="k"
              class="filter-chip"
              :class="{ active: credKind === k }"
              @click="credKind = k"
            >{{ k === 'apikey' ? 'API Key' : k === 'cookie' ? 'Cookie' : '浏览器登录' }}</button>
          </div>
          <div class="field">
            <label class="field-label">{{ credKind === 'apikey' ? 'API Key' : 'Cookie' }}</label>
            <textarea v-model="credValue" class="guide-textarea" rows="3" :placeholder="credKind === 'apikey' ? 'sk-...' : 'session=xxxx; other=yyyy'" spellcheck="false" />
          </div>
          <div v-if="credResult" class="result-banner" :class="credResult.ok ? 'ok' : 'err'">
            <span class="result-dot" /><span>{{ credResult.message }}</span>
          </div>
          <div class="modal-actions">
            <button class="btn" @click="showCredModal = false">取消</button>
            <button class="btn btn-primary" :disabled="!credValue.trim() || credSaving" @click="submitCredential(credValue)">
              {{ credSaving ? '验证中…' : '保存并验证' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
