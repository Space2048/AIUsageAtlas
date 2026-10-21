import type { AuthKind } from '~~/shared/types'

export interface PluginContext {
  providerId: string
  dataDir: string
  log: (msg: string) => void
  /**
   * 读取本渠道已存的其它凭证（如浏览器模式下取 API Key 补需要 Bearer 的接口）。
   * kind 缺省=最近更新的凭证；返回 null 表示该类型未配置。
   */
  loadCredential?: (kind?: string) => CredentialPayload | null
}

export type CredentialPayload =
  | { kind: 'apikey'; apiKey: string }
  | { kind: 'cookie'; cookie: string }
  | { kind: 'browser-login'; storageStatePath?: string }

export interface PluginAccount {
  userName?: string
  maskedContact?: string
  region?: string
}

export interface PluginPlan {
  name: string
  price?: number
  currency?: string
  renewalDate?: string | null
  autoRenew?: boolean
  /**
   * 明确声明「平台不提供/本次采集不到」的计划字段：存储置 NULL，详情页红色标「未获取到」，
   * 不再用 0/false 冒充真实值。不声明 = 沿用已存值；换采集方式后拿到真值时传 [] 清除标记。
   */
  unknownFields?: Array<'price' | 'renewalDate' | 'autoRenew'>
}

export interface PluginWindow {
  name: string
  usedPct: number
  usedValue?: number | null
  limitValue?: number | null
  unit?: string
  resetAt?: string | null
  extraUsageEnabled?: boolean
}

export interface PluginUsageDay {
  date: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  requests?: number
  costAmount?: number
  currency?: string
  // 行归属：planName 缺省用本次采集的主计划名；同日存在订阅/按量两流时按量行挂
  // '按量付费'（usage_daily 主键含 plan_name，分计划名才能并存不冲突）
  planName?: string
  // 计费平面标记，供详情页把订阅套餐与 API 按量分开展示
  billing?: 'subscription' | 'payg'
}

export interface PluginModelUsage {
  date: string
  modelId: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  thinkingTokens?: number
  requests?: number
  errors?: number
  // 计费平面标记（平台数据里带的订阅/按量区分），供详情页分组展示
  billing?: 'subscription' | 'payg'
}

export interface PluginFetchResult {
  account?: PluginAccount
  plan?: PluginPlan
  balance?: { amount: number; currency: string }
  windows?: PluginWindow[]
  usageDaily?: PluginUsageDay[]
  modelUsage?: PluginModelUsage[]
  /**
   * 声明 modelUsage 是「某日期区间的累计快照」而非逐日明细：
   * 写入前先删除该区间内的旧行，否则每次同步都换一个新日期，按模型求和会重复累加。
   */
  modelUsageWindow?: { from: string; to: string }
  /**
   * 声明 usageDaily 是「某日期区间的完整快照」：写入前先删除区间内旧行（含其他计划名）。
   * 插件改挂计划名（如把按量行迁到独立计划）或下架数据后，不删旧行会导致图表双倍计数。
   */
  usageWindow?: { from: string; to: string }
  /**
   * 当前 Key 可调用的模型列表（来自官方 /models 接口）。
   * 定义了就整体替换落库的列表，undefined 表示本次没读到、保留旧值。
   */
  availableModels?: string[]
  notes?: string[]
}

export class PluginError extends Error {
  constructor(
    public code: 'auth_expired' | 'endpoint_changed' | 'network' | 'parse' | 'not_configured',
    message: string
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

export interface CookieGuide {
  loginUrl: string
  steps: string[]
}

export interface PluginLoginResult {
  ok: boolean
  message: string
}

export interface ProviderPlugin {
  id: string
  displayName: string
  // 官方图标（public/icons/ 下的本地资源，离线可用）
  icon?: string
  authMethods: AuthKind[]
  scheduleDefaultSec: number
  // 渠道官网（添加供应商弹窗里作为副标题展示）
  homepage?: string
  // 保活页面地址（浏览器登录型渠道用，前端在此页面自动续期 token）
  consoleUrl?: string
  cookieGuide?: CookieGuide
  // 交互式登录（打开真实浏览器让用户登录，持久化会话）
  login?(ctx: PluginContext): Promise<PluginLoginResult>
  fetch(ctx: PluginContext, cred: CredentialPayload): Promise<PluginFetchResult>
}
