import type { AuthKind } from '~~/shared/types'

export interface PluginContext {
  providerId: string
  dataDir: string
  log: (msg: string) => void
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
}

export interface PluginFetchResult {
  account?: PluginAccount
  plan?: PluginPlan
  balance?: { amount: number; currency: string }
  windows?: PluginWindow[]
  usageDaily?: PluginUsageDay[]
  modelUsage?: PluginModelUsage[]
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
