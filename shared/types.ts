export type ProviderCategory = 'subscription' | 'api' | 'aggregate'
export type SyncStatus = 'ok' | 'failed'
export type AuthKind = 'apikey' | 'cookie' | 'browser-login'

export interface QuotaWindow {
  planName: string
  name: string
  usedPct: number
  usedValue: number | null
  limitValue: number | null
  unit: string
  resetAt: string
  extraUsageEnabled: boolean
}

export interface UsageDay {
  date: string
  tokens: number
  costAmount: number
  currency: string
}

export interface ProviderVM {
  id: string
  pluginId: string
  displayName: string
  icon: string
  category: ProviderCategory
  authKinds: AuthKind[]
  account: {
    userName: string
    maskedContact: string
    region: string
  }
  plan: {
    name: string
    price: number
    currency: string
    renewalDate: string | null
    autoRenew: boolean
  }
  balance: { amount: number; currency: string } | null
  windows: QuotaWindow[]
  today: { tokens: number; cost: number; currency: string }
  history: UsageDay[]
  lastSyncAt: string
  syncStatus: SyncStatus
}

export interface DashboardSummary {
  todayTokens: number
  todayCostCny: number
  activeProviders: number
  renewalsThisMonth: number
  alerts: number
}

export interface DashboardData {
  generatedAt: string
  summary: DashboardSummary
  providers: ProviderVM[]
}

export interface CookieGuide {
  loginUrl: string
  steps: string[]
}

export interface PluginMeta {
  id: string
  displayName: string
  icon?: string
  category: ProviderCategory
  authKinds: AuthKind[]
  homepage: string
  scheduleDefaultSec: number
  cookieGuide?: CookieGuide
}

export interface ModelUsageRow {
  modelId: string
  tokens: number
  requests: number
  sharePct: number
  inputPerM: number | null
  outputPerM: number | null
  currency: string | null
}

export interface SyncLogRow {
  id: number
  startedAt: string
  status: string
  durationMs: number
  errorType: string | null
  errorMsg: string | null
}

export interface ProviderDetail {
  id: string
  pluginId: string
  displayName: string
  icon: string
  category: ProviderCategory
  account: { userName: string; maskedContact: string; region: string }
  plan: { name: string; price: number; currency: string; renewalDate: string | null; autoRenew: boolean }
  balance: { amount: number; currency: string } | null
  windows: QuotaWindow[]
  usage30d: UsageDay[]
  modelUsage: ModelUsageRow[]
  syncLogs: SyncLogRow[]
  sync: { enabled: boolean; intervalSec: number }
  authKinds: AuthKind[]
  credential: { configured: boolean; kind: string | null }
}

export interface ModelPriceRow {
  providerId: string
  modelId: string
  source: string
  currency: string
  inputPerM: number
  outputPerM: number
  cachedReadPerM: number
  cachedWritePerM: number
  contextWindow: number
  effectiveFrom: string
}

export interface TokenInfo {
  id: number
  name: string
  masked: string
  createdAt: string
  lastUsedAt: string | null
}

export interface AppSettings {
  displayCurrency: string
  fxRate: number
  timezone: string
}
