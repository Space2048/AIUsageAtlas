import { fetchJson } from '~~/server/utils/http'
import { PluginError, type PluginContext, type PluginFetchResult, type ProviderPlugin } from './types'

/**
 * DeepSeek 插件
 *
 * 官方 API 的数据面很窄（2026-10-21 核对 api-docs.deepseek.com）：只有余额和模型列表。
 * 没有按日用量、没有按模型明细、没有配额窗口接口 —— 用量只能由调用方自己累计
 * chat/completions 响应里的 usage 字段。社区流传的 /v1/dashboard/billing/* 从未出现在
 * 官方文档中，不要依赖。
 *
 * 注意：DeepSeek 的鉴权过滤器在路由之前，任意路径配无效 Key 都返回 401，
 * 所以「探活返回 401」不能证明路径存在，路径只能以官方文档为准。
 */

const API_BASE = 'https://api.deepseek.com'

interface BalanceInfo {
  currency?: string
  total_balance?: string | number
  granted_balance?: string | number
  topped_up_balance?: string | number
}

interface BalanceResponse {
  is_available?: boolean
  balance_infos?: BalanceInfo[]
}

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>
}

function money(v: string | number | undefined): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  const headers = { Authorization: `Bearer ${apiKey}` }

  let balance: BalanceResponse
  try {
    balance = await fetchJson<BalanceResponse>(`${API_BASE}/user/balance`, { headers })
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
    }
    if (err.status === 404) {
      throw new PluginError('endpoint_changed', `余额接口路径已变更（HTTP 404）：${API_BASE}/user/balance`)
    }
    throw new PluginError('network', `余额接口请求失败：${err.message}`)
  }

  // 官方文档明确这些值是「整币种单位」的字符串（如 "110.00"），不是分
  const infos = balance.balance_infos ?? []
  // 官方按币种分条返回，跨币种相加会得到一个无意义的数字，所以按币种归组、只取主币种
  const byCur = new Map<string, { total: number; granted: number; toppedUp: number }>()
  for (const i of infos) {
    const cur = i.currency ?? 'USD'
    const acc = byCur.get(cur) ?? { total: 0, granted: 0, toppedUp: 0 }
    acc.total += money(i.total_balance) ?? 0
    acc.granted += money(i.granted_balance) ?? 0
    acc.toppedUp += money(i.topped_up_balance) ?? 0
    byCur.set(cur, acc)
  }
  const currency = infos[0]?.currency ?? 'USD'
  const main = byCur.get(currency) ?? { total: 0, granted: 0, toppedUp: 0 }
  const total = main.total

  let models: ModelsResponse | null = null
  try {
    models = await fetchJson<ModelsResponse>(`${API_BASE}/models`, { headers })
  } catch (e) {
    ctx.log(`模型列表获取失败：${(e as Error).message}`)
  }

  const notes: string[] = []
  if (!infos.length) notes.push('余额接口未返回 balance_infos，账户可能未开通计费')
  if (byCur.size > 1) {
    notes.push(`账户有多个币种的余额：${[...byCur].map(([c, v]) => `${c} ${v.total}`).join('、')}，卡片只显示主币种 ${currency}`)
  }
  if (infos.length) {
    notes.push(`余额构成（${currency}）：合计 ${main.total.toFixed(2)} = 赠送 ${main.granted.toFixed(2)} + 充值 ${main.toppedUp.toFixed(2)}（赠送部分会过期）`)
  }
  if (balance.is_available === false) notes.push('账户当前不可用（is_available=false），可能欠费或被限制')
  notes.push('官方无用量接口：Token 消耗与费用需由调用方累计 chat/completions 响应里的 usage，本平台无法回填历史')
  notes.push('官方无配额窗口接口：限制是账号级并发数（见文档 rate-limit），超并发返回 429 而非额度百分比')

  const list = models?.data ?? []
  if (list.length) {
    notes.push(`可用模型 ${list.length} 个：${list.map((m) => m.id).filter(Boolean).join('、')}`)
  }

  ctx.log(`余额 ${total} ${currency}，模型 ${list.length} 个`)

  return {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`,
      region: 'CN',
    },
    plan: { name: '按量付费', currency },
    balance: infos.length ? { amount: total, currency } : undefined,
    notes,
  }
}

export const deepseekPlugin: ProviderPlugin = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  icon: '/icons/deepseek.svg',
  authMethods: ['apikey'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://platform.deepseek.com',

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'apikey') return fetchViaApiKey(ctx, cred.apiKey)
    throw new PluginError('not_configured', 'DeepSeek 只支持 API Key（平台无控制台会话型采集接口）')
  },
}
