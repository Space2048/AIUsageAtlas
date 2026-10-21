import { fetchJson } from '~~/server/utils/http'
import { PluginError, type PluginContext, type PluginFetchResult, type PluginModelUsage, type PluginUsageDay, type PluginWindow, type ProviderPlugin } from './types'

/**
 * OpenCode 插件（Zen 按量网关 / Go 订阅 / Console Key）
 *
 * 2026-10-21 用真实 Key 实测确认的数据面：
 * · GET /zen/v1/models                          —— Key 探活（无效时 401 Invalid credential）
 * · GET /inference/go/v1/usage                  —— Go 订阅配额 usage.{rolling,weekly,monthly}
 * · GET /console/api/v1/budgets/members         —— 【裸数组】，元素含 user_id/email/limit_micro_cents/
 *                                                  spent_micro_cents/exceeded/resets_at
 * · GET /console/api/usage/cost-by-day?range=   —— 按日 totalCostMicroCents/totalTokens/totalRequests，
 *                                                  range 只接受 7d|30d（90d、365d 返回 400）
 * · GET /console/api/usage/models?range=&page=&pageSize= —— 按模型累计，pageInfo{page,pageSize,total,pageCount}
 * · GET /console/api/usage/summary?range=       —— 窗口内 input/output/cache 拆分合计
 *
 * 拿不到：套餐价格、续费日期、Zen 信用余额。它们走 /console/api/billing/*，
 * 实测对 API Key 返回 403（路由存在但权限不足，只认控制台会话 Cookie）。
 * 金额单位统一是 microcents（1e-6 美元）。
 *
 * 两个曾经踩过的坑：budgets 返回裸数组而不是 {members:[...]}；
 * Go 配额端点并非 Go Key 专属，Console Key 同样可读，不要按前缀跳过。
 */

const GATEWAY = 'https://opencode.ai'
const EP = {
  models: '/zen/v1/models',
  goUsage: '/inference/go/v1/usage',
  budgets: '/console/api/v1/budgets/members',
  costByDay: '/console/api/usage/cost-by-day',
  usageModels: '/console/api/usage/models',
}

// 控制台用量接口只支持这两个 range，取最长的回填历史
const RANGE = '30d'

const WINDOW_LABELS: Record<string, string> = {
  rolling: '滚动窗口',
  weekly: '周窗口',
  monthly: '月窗口',
}

interface ModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>
}

interface GoQuota {
  status?: string
  percent?: number | string
  resetsAt?: number | string
}

interface GoUsageResponse {
  usage?: Partial<Record<keyof typeof WINDOW_LABELS, GoQuota>>
}

interface BudgetRow {
  user_id?: string
  email?: string
  limit_micro_cents?: number | string
  spent_micro_cents?: number | string
  exceeded?: boolean
  resets_at?: number | string
}

// 实测该接口直接返回裸数组，不是 {members:[...]}
type BudgetsResponse = BudgetRow[] | { members?: BudgetRow[]; data?: BudgetRow[] }

interface CostDayRow {
  date?: string
  totalCostMicroCents?: number | string
  totalTokens?: number | string
  totalRequests?: number | string
}

interface ModelRow {
  model?: string
  provider?: string
  totalRequests?: number | string
  totalInputTokens?: number | string
  totalOutputTokens?: number | string
  totalCacheReadTokens?: number | string
  totalCacheWrite5mTokens?: number | string
  totalCacheWrite1hTokens?: number | string
  totalCostMicroCents?: number | string
}

interface Paged<T> {
  items?: T[]
  pageInfo?: { page?: number; pageSize?: number; total?: number; pageCount?: number }
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

function toIso(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  const n = num(v)
  if (n === undefined || n <= 0) return null
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

function asRows(res: BudgetsResponse): BudgetRow[] {
  if (Array.isArray(res)) return res
  return res.members ?? res.data ?? []
}

// 微分（microcents）→ 美元
function dollars(microCents: number | undefined): number | undefined {
  return microCents === undefined ? undefined : Number((microCents / 1_000_000).toFixed(4))
}

// 插件写入的日期一律用 UTC，与 usage_daily 其它来源保持同口径
const utcDay = (back = 0) => new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10)

function maskEmail(email: string): string {
  return email.replace(/^(.).*?(@.*)$/s, '$1***$2')
}

async function getJson<T>(path: string, apiKey: string): Promise<T> {
  return fetchJson<T>(`${GATEWAY}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } })
}

async function fetchGoWindows(apiKey: string, notes: string[]): Promise<PluginWindow[]> {
  let res: GoUsageResponse
  try {
    res = await getJson<GoUsageResponse>(EP.goUsage, apiKey)
  } catch (e) {
    notes.push(`Go 配额接口未取得：${(e as Error).message}`)
    return []
  }
  const windows: PluginWindow[] = []
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const q = res.usage?.[key as keyof typeof WINDOW_LABELS]
    if (!q) continue
    const pct = num(q.percent)
    windows.push({
      name: label,
      usedPct: pct === undefined ? 0 : Math.min(100, Math.max(0, pct)),
      usedValue: null,
      limitValue: null,
      unit: 'pct',
      resetAt: toIso(q.resetsAt),
      extraUsageEnabled: q.status === 'rate-limited',
    })
  }
  if (!windows.length) notes.push('Go 配额接口返回空 usage（该 Key 不是 Go 订阅 Key）')
  return windows
}

/** 逐页拉取按模型累计；pageCount 由服务端给出 */
async function fetchPagedModels(apiKey: string, notes: string[]): Promise<ModelRow[]> {
  const all: ModelRow[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await getJson<Paged<ModelRow>>(`${EP.usageModels}?range=${RANGE}&page=${page}&pageSize=100`, apiKey)
    const items = res.items ?? []
    all.push(...items)
    const pageCount = num(res.pageInfo?.pageCount) ?? 1
    if (page >= pageCount || !items.length) break
  }
  if (!all.length) notes.push('按模型用量接口返回空 items')
  return all
}

async function fetchViaApiKey(ctx: PluginContext, apiKey: string): Promise<PluginFetchResult> {
  const notes: string[] = []
  let models: ModelsResponse
  try {
    models = await getJson<ModelsResponse>(EP.models, apiKey)
  } catch (e) {
    const err = e as Error & { status?: number }
    if (err.status === 401 || err.status === 403) {
      throw new PluginError('auth_expired', `API Key 无效或已过期（HTTP ${err.status}）`)
    }
    throw new PluginError('network', `模型列表请求失败：${err.message}`)
  }
  const list = models.data ?? []
  if (!list.length) throw new PluginError('parse', '模型列表为空，Key 可能没有可用模型权限')

  const isConsoleKey = apiKey.startsWith('oc_sk_')
  // Go 配额端点对两类 Key 都开放（实测 Console Key 也能读），所以无条件先取
  const windows = await fetchGoWindows(apiKey, notes)
  const result: PluginFetchResult = {
    account: {
      userName: 'API 用户',
      maskedContact: `${apiKey.slice(0, 6)}••••${apiKey.slice(-4)}`,
      region: 'US',
    },
    plan: {
      name: windows.length ? 'OpenCode Go' : isConsoleKey ? 'OpenCode 按量（Console Key）' : 'OpenCode',
      currency: 'USD',
    },
    windows,
    notes,
  }

  if (isConsoleKey) await collectConsoleData(apiKey, result, notes)
  else notes.push('非 Console Key：读不到预算与消费明细')

  notes.push(`可用模型 ${list.length} 个：${list.slice(0, 8).map((m) => m.id).filter(Boolean).join('、')}${list.length > 8 ? ' …' : ''}`)
  ctx.log(`Key 可用，模型 ${list.length} 个，窗口 ${(result.windows ?? []).length} 个，日用量 ${(result.usageDaily ?? []).length} 天`)
  return result
}

async function collectConsoleData(apiKey: string, result: PluginFetchResult, notes: string[]) {
  // ---- 预算 / 账户身份 ----
  try {
    const rows = asRows(await getJson<BudgetsResponse>(EP.budgets, apiKey))
    if (!rows.length) {
      notes.push('预算接口返回空列表')
    } else {
      const email = rows.find((r) => r.email)?.email
      if (email && result.account) result.account.maskedContact = maskEmail(email)
      const limit = rows.reduce((a, r) => a + (num(r.limit_micro_cents) ?? 0), 0)
      const spent = rows.reduce((a, r) => a + (num(r.spent_micro_cents) ?? 0), 0)
      const resetAt = rows.map((r) => toIso(r.resets_at)).find(Boolean) ?? null
      if (limit > 0) {
        result.windows = [
          ...(result.windows ?? []),
          {
            name: '月度预算',
            usedPct: Math.min(100, Math.round((spent / limit) * 1000) / 10),
            usedValue: dollars(spent),
            limitValue: dollars(limit),
            unit: 'usd',
            resetAt,
            extraUsageEnabled: rows.some((r) => r.exceeded === true),
          },
        ]
      } else {
        notes.push(`未设置月度预算上限（limit=0），已消费 ${dollars(spent) ?? 0} 美元；窗口不展示无意义的 0%`)
      }
      if (rows.length > 1) notes.push(`组织内有 ${rows.length} 条成员预算记录，上面按合计展示`)
    }
  } catch (e) {
    notes.push(`预算接口未取得：${(e as Error).message}`)
  }
  notes.push('套餐价格与续费日期无法采集：/console/api/billing/* 对 API Key 返回 403（权限不足），只有控制台会话能读')

  // ---- 按日消费 ----
  try {
    const days = await getJson<CostDayRow[]>(`${EP.costByDay}?range=${RANGE}`, apiKey)
    if (Array.isArray(days) && days.length) {
      result.usageDaily = days
        .filter((d) => typeof d.date === 'string')
        .map((d) => ({
          date: String(d.date).slice(0, 10),
          // 按日接口只给 totalTokens 合计，不拆输入/输出；记在 input_tokens 上以保持日总量正确
          inputTokens: num(d.totalTokens) ?? 0,
          outputTokens: 0,
          cachedTokens: 0,
          requests: num(d.totalRequests) ?? 0,
          costAmount: dollars(num(d.totalCostMicroCents)) ?? 0,
          currency: 'USD',
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
      notes.push(`按日消费 ${result.usageDaily.length} 天（接口只给 totalTokens 合计，未拆输入/输出）`)
    } else {
      notes.push('按日消费接口返回空')
    }
  } catch (e) {
    notes.push(`按日消费未取得：${(e as Error).message}`)
  }

  // ---- 按模型累计 ----
  try {
    const rows = await fetchPagedModels(apiKey, notes)
    if (rows.length) {
      const to = utcDay()
      const from = utcDay(29)
      const modelUsage: PluginModelUsage[] = rows
        .filter((r) => r.model)
        .map((r) => ({
          date: to,
          modelId: `${r.provider ? `${r.provider}/` : ''}${r.model}`,
          inputTokens: num(r.totalInputTokens) ?? 0,
          outputTokens: num(r.totalOutputTokens) ?? 0,
          cachedTokens: (num(r.totalCacheReadTokens) ?? 0) + (num(r.totalCacheWrite5mTokens) ?? 0) + (num(r.totalCacheWrite1hTokens) ?? 0),
          requests: num(r.totalRequests) ?? 0,
        }))
      result.modelUsage = modelUsage
      // 这些值是 30 天窗口的累计快照，必须声明区间，否则按模型求和会跨窗口重复累加
      result.modelUsageWindow = { from, to }
      notes.push(`模型明细为 ${from} → ${to} 的窗口累计快照（该平台不提供逐日×模型拆分）`)
    }
  } catch (e) {
    notes.push(`按模型用量未取得：${(e as Error).message}`)
  }

  notes.push('Zen 信用余额无法采集：与套餐信息同在 /console/api/billing/* 下，API Key 无权读取')
}

export const opencodePlugin: ProviderPlugin = {
  id: 'opencode',
  displayName: 'OpenCode Zen',
  icon: '/icons/opencode.png',
  authMethods: ['apikey'],
  scheduleDefaultSec: 1800,
  homepage: 'https://opencode.ai/zen',

  async fetch(ctx, cred): Promise<PluginFetchResult> {
    if (cred.kind === 'apikey') return fetchViaApiKey(ctx, cred.apiKey)
    throw new PluginError('not_configured', 'OpenCode 只支持 API Key（控制台会话接口未公开）')
  },
}
