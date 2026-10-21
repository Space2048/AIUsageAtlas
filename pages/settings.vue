<script setup lang="ts">
import type { AppSettings, TokenInfo } from '~~/shared/types'

const { data, refresh } = await useFetch<{ settings: AppSettings; tokens: TokenInfo[]; alerts: Array<Record<string, never>> }>('/api/settings')

const form = reactive<AppSettings>({ displayCurrency: 'CNY', fxRate: 7.1, timezone: 'Asia/Shanghai' })
watch(data, (d) => { if (d) Object.assign(form, d.settings) }, { immediate: true })

const saving = ref(false)
async function save() {
  saving.value = true
  await $fetch('/api/settings', { method: 'PATCH', body: { ...form } })
  await refresh()
  saving.value = false
}

// 令牌
const newTokenName = ref('')
const revealed = ref('')
async function createToken() {
  const res = await $fetch<{ token: string }>('/api/tokens', { method: 'POST', body: { name: newTokenName.value } })
  revealed.value = res.token
  newTokenName.value = ''
  await refresh()
}
async function removeToken(id: number) {
  await $fetch(`/api/tokens/${id}`, { method: 'DELETE' })
  await refresh()
}

// 后端返回 ISO 8601（UTC+Z），按本地时区渲染，不能直接切字符串
function fmtLocal(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

useHead({ title: '设置 — AIUsageAtlas' })
</script>

<template>
  <div>
    <AppHeader />
    <main class="container">
      <div class="page-head">
        <div>
          <div class="page-title">设置</div>
          <div class="page-sub">全局偏好、访问令牌与告警规则</div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="panel">
          <div class="panel-title">显示与折算</div>
          <div class="field">
            <label class="field-label">显示币种</label>
            <div class="form-row" style="gap:8px">
              <button v-for="c in ['CNY', 'USD']" :key="c" class="filter-chip" :class="{ active: form.displayCurrency === c }" @click="form.displayCurrency = c">{{ c }}</button>
            </div>
          </div>
          <div class="field">
            <label class="field-label">USD → CNY 汇率</label>
            <input v-model.number="form.fxRate" class="field-input" type="number" step="0.01" min="0.01" style="width:140px" />
            <div class="field-hint">用于把各渠道费用折算成统一币种展示。</div>
          </div>
          <div class="field">
            <label class="field-label">时区</label>
            <input v-model="form.timezone" class="field-input" style="width:220px" />
            <div class="field-hint">各家配额窗口的重置时间按供应商当地时区换算，此处决定仪表盘倒计时的基准。</div>
          </div>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button>
        </div>

        <div class="panel">
          <div class="panel-title">访问令牌 <span class="count">托盘客户端用</span></div>
          <div v-if="revealed" class="token-reveal">
            <span>新令牌（仅显示一次，请立即复制）：</span><code>{{ revealed }}</code>
          </div>
          <div class="form-row" style="margin-bottom:16px">
            <input v-model="newTokenName" class="field-input" placeholder="令牌名称，如：我的 MacBook" />
            <button class="btn btn-primary" @click="createToken">生成</button>
          </div>
          <div v-for="t in data?.tokens" :key="t.id" class="token-row">
            <div style="flex:1">
              <div class="token-name">{{ t.name }}</div>
              <div class="token-meta">创建于 {{ fmtLocal(t.createdAt) }}<template v-if="t.lastUsedAt"> · 最近使用 {{ fmtLocal(t.lastUsedAt) }}</template></div>
            </div>
            <span class="token-masked">{{ t.masked }}</span>
            <button class="btn btn-danger" @click="removeToken(t.id)">吊销</button>
          </div>
          <div v-if="!data?.tokens.length" class="muted" style="padding:14px 0">暂无令牌</div>
        </div>

        <div class="panel full">
          <div class="panel-title">告警规则</div>
          <table class="model-table">
            <thead>
              <tr><th>供应商</th><th>指标</th><th class="num">阈值</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="a in data?.alerts" :key="a.id">
                <td class="model-name">{{ a.provider_id }}</td>
                <td>{{ a.metric === 'used_pct' ? '额度使用率' : a.metric === 'balance' ? '余额低于' : a.metric }}</td>
                <td class="num">{{ a.metric === 'used_pct' ? a.threshold + '%' : a.threshold }}</td>
                <td><span class="badge badge-api">{{ a.enabled ? '启用' : '停用' }}</span></td>
              </tr>
              <tr v-if="!data?.alerts.length"><td colspan="4" class="muted" style="text-align:center;padding:20px">暂无告警规则</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
</template>
