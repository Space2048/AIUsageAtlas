import { fetchJson } from '~~/server/utils/http'
import { PluginError, type PluginContext, type PluginFetchResult, type ProviderPlugin } from './types'

/**
 * 智谱 BigModel 插件
 *
 * 2026-10-21 核对 docs.bigmodel.cn 全文与实测的结论：官方 API **只有推理接口**，
 * 没有任何账户侧数据面 ——
 * · 余额：社区代码里的 POST /api/balance 已失效，实测返回 {"code":500,"msg":"404 NOT_FOUND"}，
 *   官方文档全文 0 命中 api/balance / cashBalance / productId。
 * · 用量：没有 /usage、没有按日或按模型统计接口，账单只在控制台「财务总览/费用账单」页。
 * · GLM Coding Plan 的 5 小时 / 周滚动窗口：控制台专属，API 侧只能在被限流时从
 *   429 的 error code（1308/1310/1316/1317/1318-1321，带 next_flush_time）被动读到。
 *
 * 所以本插件只做「Key 是否可用 + 属于哪一类 Key」，不编造任何数字。
 * 2026-10-16 起标准 Key 与 Coding Plan Key 不通用，Coding Plan 基座是 /api/coding/paas/v4，
 * 因此两个基座都要试：只试标准基座会把合法的 Coding Plan Key 误判成失效。
 */

const BASES = [
  { label: '标准推理', path: '/api/paas/v4/models' },
  { label: 'GLM Coding Plan', path: '/api/coding/paas/v4/models' },
]

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>
  model?: string[]
}

async function probeBase(apiKey: string, path: string): Promise<{ ok: boolean; status?: number; models: string[] }> {
  try {
    const res = await fetchJson<ModelsResponse>(`https://open.bigmodel.cn${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const rows = res.data ?? res.model ?? []
    const models = rows
      .map((m) => (typeof m === 'string' ? m : m.id ?? ''))
      .filter(Boolean) as string[]
    return { ok: true, models }
  } catch (e) {
    const err = e as Error & { status?: number }
    return { ok: false, status: err.status, models: [] }
  }
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  const results = await Promise.all(BASES.map(async (b) => ({ base: b, ...(await probeBase(apiKey, b.path)) })))
  const accepted = results.filter((r) => r.ok)

  if (!accepted.length) {
    const first = results[0]
    if (first.status === 401 || first.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${first.status}，标准与 Coding Plan 两个基座都被拒）`)
    }
    throw new PluginError('network', `Key 校验请求失败（HTTP ${first.status ?? '无响应'}）`)
  }

  const notes: string[] = []
  notes.push(`Key 可用基座：${accepted.map((a) => a.base.label).join('、')}`)
  notes.push('官方 API 不提供余额、按日用量与配额窗口接口，这三项在控制台页面，本平台暂无法采集')
  for (const a of accepted) {
    notes.push(
      a.models.length
        ? `${a.base.label} 可见模型 ${a.models.length} 个：${a.models.slice(0, 8).join('、')}${a.models.length > 8 ? ' …' : ''}`
        : `${a.base.label} 模型列表为空（该基座未返回可读列表，仅证明 Key 有效）`
    )
  }

  const isCoding = accepted.some((a) => a.base.path.includes('/coding/'))
  ctx.log(`Key 有效（${notes[0]?.replace('Key 可用基座：', '') ?? '未知'}）`)

  return {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`,
      region: 'CN',
    },
    plan: { name: isCoding ? 'GLM Coding Plan' : '按量付费', currency: 'CNY' },
    notes,
  }
}

export const bigmodelPlugin: ProviderPlugin = {
  id: 'bigmodel',
  displayName: 'BigModel 智谱',
  icon: '/icons/bigmodel.png',
  authMethods: ['apikey'],
  scheduleDefaultSec: 6 * 3600,
  homepage: 'https://open.bigmodel.cn',

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'apikey') return fetchViaApiKey(ctx, cred.apiKey)
    throw new PluginError('not_configured', 'BigModel 只支持 API Key（余额与用量在控制台页面，尚无公开接口）')
  },
}
