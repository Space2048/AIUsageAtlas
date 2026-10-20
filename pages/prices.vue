<script setup lang="ts">
import type { ModelPriceRow } from '~~/shared/types'

const { data } = await useFetch<{ prices: ModelPriceRow[] }>('/api/prices')
const filter = ref('all')

const providers = computed(() => {
  const set = new Set((data.value?.prices ?? []).map((p) => p.providerId))
  return ['all', ...[...set]]
})

const filtered = computed(() => {
  const list = data.value?.prices ?? []
  // 同一模型只保留最新生效价
  const latest = new Map<string, ModelPriceRow>()
  for (const p of list) {
    const key = `${p.providerId}/${p.modelId}`
    const prev = latest.get(key)
    if (!prev || p.effectiveFrom > prev.effectiveFrom) latest.set(key, p)
  }
  const rows = [...latest.values()]
  return filter.value === 'all' ? rows : rows.filter((p) => p.providerId === filter.value)
})

function label(p: string): string {
  return p === 'all' ? '全部' : p === 'litellm' ? 'LiteLLM 公共库' : p
}

function fmt(n: number, cur: string): string {
  const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : cur + ' '
  return sym + n
}

useHead({ title: '价格表 — AIUsageAtlas' })
</script>

<template>
  <div>
    <AppHeader />
    <main class="container">
      <div class="page-head">
        <div>
          <div class="page-title">模型价格表</div>
          <div class="page-sub">来自 LiteLLM 公共价格库与渠道插件自带价格 · 每日自动刷新快照</div>
        </div>
      </div>

      <div class="filter-row">
        <button v-for="p in providers" :key="p" class="filter-chip" :class="{ active: filter === p }" @click="filter = p">
          {{ label(p) }}
        </button>
      </div>

      <div class="panel" style="padding:8px 14px">
        <table class="price-table">
          <thead>
            <tr>
              <th>渠道</th><th>模型</th><th class="num">输入 /M</th><th class="num">输出 /M</th>
              <th class="num">缓存读 /M</th><th class="num">缓存写 /M</th><th class="num">上下文</th><th>生效日期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filtered" :key="p.providerId + p.modelId">
              <td><span class="prov-tag" :class="p.providerId">{{ label(p.providerId) }}</span></td>
              <td class="model-name">{{ p.modelId }}</td>
              <td class="num">{{ fmt(p.inputPerM, p.currency) }}</td>
              <td class="num">{{ fmt(p.outputPerM, p.currency) }}</td>
              <td class="num muted">{{ fmt(p.cachedReadPerM, p.currency) }}</td>
              <td class="num muted">{{ fmt(p.cachedWritePerM, p.currency) }}</td>
              <td class="num muted">{{ p.contextWindow ? (p.contextWindow / 1000) + 'K' : '—' }}</td>
              <td class="muted">{{ p.effectiveFrom }}</td>
            </tr>
            <tr v-if="!filtered.length"><td colspan="8" class="muted" style="text-align:center;padding:24px">暂无价格数据</td></tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>
</template>
