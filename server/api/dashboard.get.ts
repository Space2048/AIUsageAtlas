import { getDb } from '~~/server/utils/db'
import { seedIfEmpty } from '~~/server/utils/seed'
import type { DashboardData, ProviderVM, QuotaWindow, UsageDay } from '~~/shared/types'

export default defineEventHandler((): DashboardData => {
  const db = getDb()
  seedIfEmpty(db)

  const USD_TO_CNY = 7.1

  const providerRows = db
    .prepare(`SELECT id, plugin_id, display_name, category, icon FROM provider ORDER BY rowid`)
    .all() as Array<{ id: string; plugin_id: string; display_name: string; category: string; icon: string | null }>

  const providers: ProviderVM[] = providerRows.map((p) => {
    const profile = db
      .prepare(`SELECT user_name, masked_contact, region FROM account_profile WHERE provider_id = ?`)
      .get(p.id) as { user_name: string; masked_contact: string; region: string } | undefined

    const subs = db
      .prepare(`SELECT plan_name, price, currency, renewal_date, auto_renew FROM subscription WHERE provider_id = ?`)
      .all(p.id) as Array<{ plan_name: string; price: number; currency: string; renewal_date: string | null; auto_renew: number }>
    const plan = subs[0] ?? { plan_name: '未知计划', price: 0, currency: 'CNY', renewal_date: null, auto_renew: 0 }

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

    const history: UsageDay[] = (
      db
        .prepare(
          `SELECT date, (input_tokens + output_tokens + cached_tokens) AS tokens, cost_amount, cost_currency
           FROM usage_daily WHERE provider_id = ? ORDER BY date DESC LIMIT 7`
        )
        .all(p.id) as Array<{ date: string; tokens: number; cost_amount: number; cost_currency: string }>
    )
      .reverse()
      .map((r) => ({ date: r.date, tokens: r.tokens, costAmount: r.cost_amount, currency: r.cost_currency }))

    const lastSync = db
      .prepare(`SELECT started_at, status FROM sync_log WHERE provider_id = ? ORDER BY id DESC LIMIT 1`)
      .get(p.id) as { started_at: string; status: string } | undefined

    return {
      id: p.id,
      pluginId: p.plugin_id,
      displayName: p.display_name,
      category: p.category as ProviderVM['category'],
      icon: p.icon || '',
      authKinds: ['apikey', 'cookie', 'browser-login'],
      account: {
        userName: profile?.user_name ?? '未连接',
        maskedContact: profile?.masked_contact ?? '',
        region: profile?.region ?? '',
      },
      plan: {
        name: plan.plan_name,
        price: plan.price,
        currency: plan.currency,
        renewalDate: plan.renewal_date,
        autoRenew: !!plan.auto_renew,
      },
      balance: balance ? { amount: balance.balance, currency: balance.currency } : null,
      windows,
      today: {
        tokens: history.at(-1)?.tokens ?? 0,
        cost: history.at(-1)?.costAmount ?? 0,
        currency: history.at(-1)?.currency ?? plan.currency,
      },
      history,
      lastSyncAt: lastSync?.started_at ?? new Date().toISOString(),
      syncStatus: (lastSync?.status as ProviderVM['syncStatus']) ?? 'ok',
    }
  })

  const today = providers.reduce((acc, p) => acc + p.today.tokens, 0)
  const costCny = providers.reduce(
    (acc, p) => acc + (p.today.currency === 'USD' ? p.today.cost * USD_TO_CNY : p.today.cost),
    0
  )
  const monthStart = new Date().toISOString().slice(0, 8) + '01'
  const renewalsThisMonth = providerRows.filter((p) => {
    const sub = db
      .prepare(`SELECT renewal_date FROM subscription WHERE provider_id = ? AND renewal_date >= ? AND renewal_date <= date('now', '+1 month')`)
      .get(p.id, monthStart) as { renewal_date: string } | undefined
    return !!sub
  }).length

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      todayTokens: today,
      todayCostCny: Number(costCny.toFixed(2)),
      activeProviders: providers.length,
      renewalsThisMonth,
      alerts: (db.prepare(`SELECT COUNT(*) AS n FROM alert_rule WHERE enabled = 1`).get() as { n: number }).n,
    },
    providers,
  }
})
