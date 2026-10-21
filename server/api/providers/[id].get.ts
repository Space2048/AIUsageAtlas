import { getPlugin } from '~~/server/providers'
import { getDb } from '~~/server/utils/db'
import type { ModelUsageRow, ProviderDetail, SyncLogRow, UsageDay } from '~~/shared/types'

export default defineEventHandler((event): ProviderDetail => {
  const id = getRouterParam(event, 'id')!
  const db = getDb()

  const p = db
    .prepare(`SELECT id, plugin_id, display_name, category, icon FROM provider WHERE id = ?`)
    .get(id) as { id: string; plugin_id: string; display_name: string; category: string; icon: string | null } | undefined
  if (!p) throw createError({ statusCode: 404, statusMessage: '供应商不存在' })

  const profile = db
    .prepare(`SELECT user_name, masked_contact, region FROM account_profile WHERE provider_id = ?`)
    .get(id) as { user_name: string; masked_contact: string; region: string } | undefined

  const plan = db
    .prepare(`SELECT plan_name, price, currency, renewal_date, auto_renew, unknown_fields FROM subscription WHERE provider_id = ?`)
    .all(id)[0] as
    | { plan_name: string; price: number | null; currency: string; renewal_date: string | null; auto_renew: number | null; unknown_fields: string | null }
    | undefined

  const balance = db
    .prepare(`SELECT balance, currency FROM balance_snapshot WHERE provider_id = ? ORDER BY date DESC LIMIT 1`)
    .get(id) as { balance: number; currency: string } | undefined

  const windows = (
    db
      .prepare(`SELECT plan_name, name, used_pct, used_value, limit_value, unit, reset_at, extra_usage_enabled FROM quota_window WHERE provider_id = ?`)
      .all(id) as Array<Record<string, never>>
  ).map((w) => ({
    planName: w.plan_name,
    name: w.name,
    usedPct: w.used_pct,
    usedValue: w.used_value,
    limitValue: w.limit_value,
    unit: w.unit,
    resetAt: w.reset_at,
    extraUsageEnabled: !!w.extra_usage_enabled,
  }))

  const usage30d: UsageDay[] = (
    db
      .prepare(
        `SELECT date,
                SUM(input_tokens + output_tokens + cached_tokens) AS tokens,
                SUM(CASE WHEN billing = 'subscription' THEN input_tokens + output_tokens + cached_tokens ELSE 0 END) AS sub_tokens,
                SUM(CASE WHEN billing = 'payg' THEN input_tokens + output_tokens + cached_tokens ELSE 0 END) AS payg_tokens,
                SUM(cost_amount) AS cost_amount,
                MAX(cost_currency) AS cost_currency
         FROM usage_daily WHERE provider_id = ? GROUP BY date ORDER BY date ASC LIMIT 90`
      )
      .all(id) as Array<{
        date: string
        tokens: number
        sub_tokens: number
        payg_tokens: number
        cost_amount: number
        cost_currency: string
      }>
  ).map((r) => ({
    date: r.date,
    tokens: r.tokens,
    costAmount: r.cost_amount,
    currency: r.cost_currency,
    subscriptionTokens: r.sub_tokens,
    paygTokens: r.payg_tokens,
  }))

  const modelRows = db
    .prepare(
      `SELECT model_id, billing, SUM(input_tokens + output_tokens + cached_tokens) AS tokens, SUM(requests) AS requests
       FROM usage_model_daily WHERE provider_id = ? GROUP BY model_id, billing ORDER BY tokens DESC`
    )
    .all(id) as Array<{ model_id: string; billing: string | null; tokens: number; requests: number }>
  const totalTokens = modelRows.reduce((a, r) => a + r.tokens, 0) || 1

  const modelUsage: ModelUsageRow[] = modelRows.map((r) => {
    const price = db
      .prepare(
        `SELECT input_per_m, output_per_m, currency FROM model_price
         WHERE model_id = ? AND effective_from <= date('now') ORDER BY effective_from DESC LIMIT 1`
      )
      .get(r.model_id) as { input_per_m: number; output_per_m: number; currency: string } | undefined
    return {
      modelId: r.model_id,
      tokens: r.tokens,
      requests: r.requests,
      sharePct: Math.round((r.tokens / totalTokens) * 1000) / 10,
      inputPerM: price?.input_per_m ?? null,
      outputPerM: price?.output_per_m ?? null,
      currency: price?.currency ?? null,
      billing: r.billing === 'subscription' || r.billing === 'payg' ? r.billing : null,
    }
  })

  const availableModels = (
    db
      .prepare(`SELECT model_id FROM available_model WHERE provider_id = ? ORDER BY model_id`)
      .all(id) as Array<{ model_id: string }>
  ).map((r) => r.model_id)

  // started_at 由 datetime('now') 写入，是无时区标记的 UTC 串；转成带 Z 的 ISO 8601，前端才能按本地时间解析
  const syncLogs: SyncLogRow[] = (
    db
      .prepare(
        `SELECT id, COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', started_at), started_at) AS started_at, status, duration_ms, error_type, error_msg
         FROM sync_log WHERE provider_id = ? ORDER BY id DESC LIMIT 5`
      )
      .all(id) as Array<Record<string, never>>
  ).map((l) => ({
    id: l.id,
    startedAt: l.started_at,
    status: l.status,
    durationMs: l.duration_ms,
    errorType: l.error_type,
    errorMsg: l.error_msg,
  }))

  const sync = db
    .prepare(`SELECT enabled, interval_sec FROM sync_config WHERE provider_id = ?`)
    .get(id) as { enabled: number; interval_sec: number } | undefined

  const credRow = db
    .prepare(`SELECT kind FROM credential WHERE provider_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(id) as { kind: string } | undefined

  return {
    id: p.id,
    pluginId: p.plugin_id,
    displayName: p.display_name,
    category: p.category as ProviderDetail['category'],
    icon: p.icon || '',
    account: {
      userName: profile?.user_name ?? '未连接',
      maskedContact: profile?.masked_contact ?? '',
      region: profile?.region ?? '',
    },
    plan: {
      name: plan?.plan_name ?? '未知计划',
      price: plan?.price ?? 0,
      currency: plan?.currency ?? 'CNY',
      renewalDate: plan?.renewal_date ?? null,
      autoRenew: !!plan?.auto_renew,
      unknownFields: (plan?.unknown_fields ?? '').split(',').filter(Boolean),
    },
    balance: balance ? { amount: balance.balance, currency: balance.currency } : null,
    windows,
    usage30d,
    modelUsage,
    availableModels,
    syncLogs,
    sync: { enabled: !!sync?.enabled, intervalSec: sync?.interval_sec ?? 3600 },
    authKinds: getPlugin(p.plugin_id)?.authMethods ?? [],
    credential: { configured: !!credRow, kind: credRow?.kind ?? null },
  }
})
