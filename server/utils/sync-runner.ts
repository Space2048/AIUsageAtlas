import { getDb } from './db'
import { getPlugin } from '~~/server/providers'
import { PluginError, type CredentialPayload, type PluginFetchResult } from '~~/server/providers/types'

export interface SyncOutcome {
  providerId: string
  ok: boolean
  mode: 'live' | 'mock'
  error?: string
}

function loadCredential(providerId: string): CredentialPayload | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT kind, payload_enc FROM credential WHERE provider_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(providerId) as { kind: string; payload_enc: string } | undefined
  if (!row?.payload_enc) return null
  try {
    const parsed = JSON.parse(row.payload_enc) as CredentialPayload
    return parsed
  } catch {
    return null
  }
}

function applyResult(providerId: string, result: PluginFetchResult) {
  const db = getDb()

  if (result.account) {
    const existing = db.prepare(`SELECT provider_id FROM account_profile WHERE provider_id = ?`).get(providerId)
    if (existing) {
      db.prepare(
        `UPDATE account_profile SET user_name = COALESCE(NULLIF(?, ''), user_name), masked_contact = COALESCE(NULLIF(?, ''), masked_contact), region = COALESCE(NULLIF(?, ''), region) WHERE provider_id = ?`
      ).run(result.account.userName ?? '', result.account.maskedContact ?? '', result.account.region ?? '', providerId)
    } else {
      db.prepare(
        `INSERT INTO account_profile (provider_id, user_name, masked_contact, region, avatar_text) VALUES (?, ?, ?, ?, ?)`
      ).run(
        providerId,
        result.account.userName ?? '未连接',
        result.account.maskedContact ?? '',
        result.account.region ?? '',
        (result.account.userName ?? 'AT').slice(0, 2).toUpperCase()
      )
    }
  }

  if (result.plan) {
    const has = db.prepare(`SELECT plan_name FROM subscription WHERE provider_id = ? LIMIT 1`).get(providerId) as
      | { plan_name: string }
      | undefined
    if (has) {
      db.prepare(
        `UPDATE subscription SET plan_name = ?, price = COALESCE(?, price), currency = COALESCE(?, currency), renewal_date = COALESCE(?, renewal_date), auto_renew = COALESCE(?, auto_renew) WHERE provider_id = ? AND plan_name = ?`
      ).run(
        result.plan.name,
        result.plan.price ?? null,
        result.plan.currency ?? null,
        result.plan.renewalDate ?? null,
        result.plan.autoRenew === undefined ? null : result.plan.autoRenew ? 1 : 0,
        providerId,
        has.plan_name
      )
    } else {
      db.prepare(
        `INSERT INTO subscription (provider_id, plan_name, price, currency, renewal_date, auto_renew) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        providerId,
        result.plan.name,
        result.plan.price ?? 0,
        result.plan.currency ?? 'CNY',
        result.plan.renewalDate ?? null,
        result.plan.autoRenew ? 1 : 0
      )
    }
  }

  if (result.balance) {
    db.prepare(
      `INSERT OR REPLACE INTO balance_snapshot (provider_id, date, balance, currency) VALUES (?, date('now'), ?, ?)`
    ).run(providerId, result.balance.amount, result.balance.currency)
  }

  if (result.windows?.length) {
    // 插件未返回的窗口保留原值，返回的覆盖
    for (const w of result.windows) {
      db.prepare(
        `INSERT INTO quota_window (provider_id, plan_name, name, used_pct, used_value, limit_value, unit, reset_at, extra_usage_enabled, updated_at)
         VALUES (?, '实时', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(provider_id, plan_name, name) DO UPDATE SET
           used_pct = excluded.used_pct, used_value = excluded.used_value, limit_value = excluded.limit_value,
           unit = excluded.unit, reset_at = excluded.reset_at, extra_usage_enabled = excluded.extra_usage_enabled,
           updated_at = datetime('now')`
      ).run(
        providerId,
        w.name,
        w.usedPct,
        w.usedValue ?? null,
        w.limitValue ?? null,
        w.unit ?? 'pct',
        w.resetAt ?? null,
        w.extraUsageEnabled ? 1 : 0
      )
    }
  }

  for (const u of result.usageDaily ?? []) {
    db.prepare(
      `INSERT INTO usage_daily (provider_id, plan_name, date, input_tokens, output_tokens, cached_tokens, requests, cost_amount, cost_currency, source)
       VALUES (?, '实时', ?, ?, ?, ?, ?, ?, ?, 'api')
       ON CONFLICT(provider_id, plan_name, date) DO UPDATE SET
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens,
         requests = excluded.requests, cost_amount = excluded.cost_amount, cost_currency = excluded.cost_currency`
    ).run(
      providerId,
      u.date,
      u.inputTokens ?? 0,
      u.outputTokens ?? 0,
      u.cachedTokens ?? 0,
      u.requests ?? 0,
      u.costAmount ?? 0,
      u.currency ?? 'CNY'
    )
  }

  for (const m of result.modelUsage ?? []) {
    db.prepare(
      `INSERT OR REPLACE INTO usage_model_daily (provider_id, date, model_id, input_tokens, output_tokens, cached_tokens, thinking_tokens, requests, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      providerId,
      m.date,
      m.modelId,
      m.inputTokens ?? 0,
      m.outputTokens ?? 0,
      m.cachedTokens ?? 0,
      m.thinkingTokens ?? 0,
      m.requests ?? 0,
      m.errors ?? 0
    )
  }
}

function mockJitter(providerId: string) {
  const db = getDb()
  db.prepare(
    `UPDATE quota_window SET used_pct = MIN(100, MAX(0, used_pct + (? - 0.5) * 2)) WHERE provider_id = ?`
  ).run(Math.random(), providerId)
}

export async function runProviderSync(providerId: string): Promise<SyncOutcome> {
  const db = getDb()
  const started = Date.now()

  const provider = db
    .prepare(`SELECT id, plugin_id, display_name FROM provider WHERE id = ?`)
    .get(providerId) as { id: string; plugin_id: string; display_name: string } | undefined
  if (!provider) {
    return { providerId, ok: false, mode: 'mock', error: '供应商不存在' }
  }

  const plugin = getPlugin(provider.plugin_id)
  const cred = loadCredential(providerId)

  // 无插件或无凭证：保持 mock 抖动，维持演示数据可用
  if (!plugin || !cred) {
    mockJitter(providerId)
    db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_type, error_msg) VALUES (?, 'ok', ?, NULL, ?)`)
      .run(providerId, Date.now() - started, !plugin ? 'mock: 插件未实现' : 'mock: 未配置凭证')
    return { providerId, ok: true, mode: 'mock' }
  }

  try {
    const logs: string[] = []
    const result = await plugin.fetch(
      {
        providerId,
        dataDir: process.env.DATA_DIR || '.data',
        log: (m) => logs.push(m),
      },
      cred
    )
    applyResult(providerId, result)
    const note = [...(result.notes ?? []), ...logs].join('；')
    db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_type, error_msg) VALUES (?, 'ok', ?, NULL, ?)`)
      .run(providerId, Date.now() - started, note.slice(0, 2000) || null)
    return { providerId, ok: true, mode: 'live' }
  } catch (e) {
    const code = e instanceof PluginError ? e.code : 'network'
    db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_type, error_msg) VALUES (?, 'failed', ?, ?, ?)`)
      .run(providerId, Date.now() - started, code, (e as Error).message.slice(0, 2000))
    return { providerId, ok: false, mode: 'live', error: (e as Error).message }
  }
}
