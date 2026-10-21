import { getDb } from '~~/server/utils/db'
import { getPlugin } from '~~/server/providers'
import type { DashboardData, ProviderVM, QuotaWindow, UsageDay } from '~~/shared/types'

// 插件写入 usage_daily 的日期是 UTC 日（tsToDate 用 toISOString），这里必须同口径，
// 否则东八区每天 0~8 点会把「今天」查成昨天
const utcDay = (back = 0) => new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10)

interface DayAgg {
  tokens: number
  cost_amount: number
  cost_currency: string | null
}

export default defineEventHandler((): DashboardData => {
  const db = getDb()

  const settingRows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>
  const kv = Object.fromEntries(settingRows.map((r) => [r.key, r.value]))
  const FX_TO_CNY = Number(kv.fx_rate) || 7.1
  const today = utcDay()

  const providerRows = db
    .prepare(`SELECT id, plugin_id, display_name, category, icon FROM provider ORDER BY rowid`)
    .all() as Array<{ id: string; plugin_id: string; display_name: string; category: string; icon: string | null }>

  const providers: ProviderVM[] = providerRows.map((p) => {
    const profile = db
      .prepare(`SELECT user_name, masked_contact, region FROM account_profile WHERE provider_id = ?`)
      .get(p.id) as { user_name: string; masked_contact: string; region: string } | undefined

    const subs = db
      .prepare(`SELECT plan_name, price, currency, renewal_date, auto_renew, unknown_fields FROM subscription WHERE provider_id = ?`)
      .all(p.id) as Array<{ plan_name: string; price: number | null; currency: string; renewal_date: string | null; auto_renew: number | null; unknown_fields: string | null }>
    const plan = subs[0] ?? { plan_name: '未知计划', price: 0, currency: 'CNY', renewal_date: null, auto_renew: 0, unknown_fields: '' }

    const windowRows = db
      .prepare(`SELECT plan_name, name, used_pct, used_value, limit_value, unit, reset_at, extra_usage_enabled FROM quota_window WHERE provider_id = ?`)
      .all(p.id) as Array<Record<string, never>>
    const windows: QuotaWindow[] = windowRows.map((w) => ({
      planName: w.plan_name,
      name: w.name,
      usedPct: w.used_pct,
      usedValue: w.used_value,
      limitValue: w.limit_value,
      unit: w.unit,
      resetAt: w.reset_at,
      extraUsageEnabled: !!w.extra_usage_enabled,
    }))

    const balance = db
      .prepare(`SELECT balance, currency FROM balance_snapshot WHERE provider_id = ? ORDER BY date DESC LIMIT 1`)
      .get(p.id) as { balance: number; currency: string } | undefined

    // 近 7 个日历日，无数据的日期补 0（原来取「最近 7 条记录」，稀疏时跨度会远超 7 天）
    const dayRows = db
      .prepare(
        `SELECT date, SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
                SUM(cost_amount) AS cost_amount, MAX(cost_currency) AS cost_currency
         FROM usage_daily WHERE provider_id = ? AND date >= ? GROUP BY date`
      )
      .all(p.id, utcDay(6)) as Array<DayAgg & { date: string }>
    const byDate = new Map(dayRows.map((r) => [r.date, r]))
    const history: UsageDay[] = Array.from({ length: 7 }, (_, i) => {
      const date = utcDay(6 - i)
      const row = byDate.get(date)
      return { date, tokens: row?.tokens ?? 0, costAmount: row?.cost_amount ?? 0, currency: row?.cost_currency ?? plan.currency }
    })

    const todayRow = db
      .prepare(
        `SELECT SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
                SUM(cost_amount) AS cost_amount, MAX(cost_currency) AS cost_currency
         FROM usage_daily WHERE provider_id = ? AND date = ?`
      )
      .get(p.id, today) as DayAgg | undefined

    // sync_log.started_at 由 datetime('now') 写入，是无时区标记的 UTC 串；
    // 前端 new Date() 会把它当本地时间解析，必须在此转成带 Z 的 ISO 8601
    const lastSync = db
      .prepare(
        `SELECT COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', started_at), started_at) AS started_at, status
         FROM sync_log WHERE provider_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(p.id) as { started_at: string; status: string } | undefined

    return {
      id: p.id,
      pluginId: p.plugin_id,
      displayName: p.display_name,
      category: p.category as ProviderVM['category'],
      icon: p.icon || '',
      authKinds: getPlugin(p.plugin_id)?.authMethods ?? [],
      account: {
        userName: profile?.user_name ?? '未连接',
        maskedContact: profile?.masked_contact ?? '',
        region: profile?.region ?? '',
      },
      plan: {
        name: plan.plan_name,
        price: plan.price ?? 0,
        currency: plan.currency,
        renewalDate: plan.renewal_date,
        autoRenew: !!plan.auto_renew,
        unknownFields: (plan.unknown_fields ?? '').split(',').filter(Boolean),
      },
      balance: balance ? { amount: balance.balance, currency: balance.currency } : null,
      windows,
      today: {
        tokens: todayRow?.tokens ?? 0,
        cost: todayRow?.cost_amount ?? 0,
        currency: todayRow?.cost_currency ?? plan.currency,
      },
      history,
      lastSyncAt: lastSync?.started_at ?? new Date().toISOString(),
      syncStatus: (lastSync?.status as ProviderVM['syncStatus']) ?? 'ok',
    }
  })

  const todayTokens = providers.reduce((acc, p) => acc + p.today.tokens, 0)
  const costCny = providers.reduce(
    (acc, p) => acc + (p.today.currency === 'USD' ? p.today.cost * FX_TO_CNY : p.today.cost),
    0
  )
  // 「30 天内续费」= 今天起 30 天内到期，不含已过期（原来的「本月 1 号起」会把已过期的当月续费漏掉）
  const renewalsSoon = providerRows.filter((p) => {
    const sub = db
      .prepare(`SELECT renewal_date FROM subscription WHERE provider_id = ? AND renewal_date >= ? AND renewal_date <= ?`)
      .get(p.id, today, utcDay(-30)) as { renewal_date: string } | undefined
    return !!sub
  }).length

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      todayTokens,
      todayCostCny: Number(costCny.toFixed(2)),
      activeProviders: providers.length,
      renewalsThisMonth: renewalsSoon,
      alerts: (db.prepare(`SELECT COUNT(*) AS n FROM alert_rule WHERE enabled = 1`).get() as { n: number }).n,
    },
    providers,
  }
})
