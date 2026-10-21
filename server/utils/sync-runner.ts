import type { DatabaseSync } from 'node:sqlite'
import { getDb } from './db'
import { getPlugin } from '~~/server/providers'
import { PluginError, type CredentialPayload, type PluginFetchResult } from '~~/server/providers/types'

export interface SyncOutcome {
  providerId: string
  ok: boolean
  mode: 'live' | 'unconfigured'
  error?: string
}

function loadCredential(providerId: string, kind?: string): CredentialPayload | null {
  const db = getDb()
  const row = (
    kind
      ? db.prepare(`SELECT kind, payload_enc FROM credential WHERE provider_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 1`)
      : db.prepare(`SELECT kind, payload_enc FROM credential WHERE provider_id = ? ORDER BY updated_at DESC LIMIT 1`)
  ).get(...(kind ? [providerId, kind] : [providerId])) as { kind: string; payload_enc: string } | undefined
  if (!row?.payload_enc) return null
  try {
    const parsed = JSON.parse(row.payload_enc) as CredentialPayload
    return parsed
  } catch {
    return null
  }
}

// 把旧计划名下的历史整体迁到新计划名：先删掉新名下会撞主键的行，再改名。
// 保留旧行是因为它常来自更长的查询窗口，属于超集。表名写死，不接外部输入。
function renamePlan(db: DatabaseSync, providerId: string, from: string, to: string) {
  for (const [table, keyCol] of [
    ['usage_daily', 'date'],
    ['quota_window', 'name'],
  ] as const) {
    db.prepare(
      `DELETE FROM ${table}
       WHERE provider_id = ? AND plan_name = ?
         AND ${keyCol} IN (SELECT ${keyCol} FROM ${table} WHERE provider_id = ? AND plan_name = ?)`
    ).run(providerId, to, providerId, from)
    db.prepare(`UPDATE ${table} SET plan_name = ? WHERE provider_id = ? AND plan_name = ?`).run(to, providerId, from)
  }
}

// 钱包型渠道（按量付费余额）在官方没有按日消费接口时，用余额差分推算当日消费。
// 只在本次采集未提供按日【消费金额】时启用，避免与真实费用重复计数；token 数无法由余额推出，留 0。
function deriveDailySpend(
  db: DatabaseSync,
  providerId: string,
  planName: string,
  balance: { amount: number; currency: string },
  notes: string[]
) {
  const today = new Date().toISOString().slice(0, 10)
  const prev = db
    .prepare(`SELECT date, balance FROM balance_snapshot WHERE provider_id = ? AND date < ? ORDER BY date DESC LIMIT 1`)
    .get(providerId, today) as { date: string; balance: number } | undefined

  if (!prev) {
    notes.push('余额差分推算消费：暂无更早的余额快照可比对，明日起生效')
    return
  }
  const gapDays = Math.round((Date.parse(today) - Date.parse(prev.date)) / 86400_000)
  if (gapDays > 1) {
    notes.push(`余额差分未采用：上次余额快照是 ${prev.date}（隔了 ${gapDays} 天），跨天消费无法归到某一天`)
    return
  }

  const delta = Number((prev.balance - balance.amount).toFixed(4))
  if (delta > 0) {
    db.prepare(
      `INSERT INTO usage_daily (provider_id, plan_name, date, input_tokens, output_tokens, cached_tokens, requests, cost_amount, cost_currency, source, billing)
       VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, 'balance_delta', 'payg')
       ON CONFLICT(provider_id, plan_name, date) DO UPDATE SET cost_amount = excluded.cost_amount, cost_currency = excluded.cost_currency`
    ).run(providerId, planName, today, delta, balance.currency)
    notes.push(`按日消费由余额差分推算：${prev.balance} − ${balance.amount} = ${delta} ${balance.currency}（Token 数无法推算）`)
  } else if (delta < 0) {
    const recharged = Number((-delta).toFixed(4))
    db.prepare(`UPDATE balance_snapshot SET recharged_amount = ? WHERE provider_id = ? AND date = ?`).run(recharged, providerId, today)
    notes.push(`检测到充值 ${recharged} ${balance.currency}，未计入消费`)
  }
}

function applyResult(providerId: string, result: PluginFetchResult) {
  const db = getDb()

  // quota_window 与 usage_daily 的主键含 plan_name，写死占位值会让这三张表 join 不上：
  // 以本次采集的计划名为准，缺省时沿用已落库的那条
  const planName =
    result.plan?.name ??
    (db.prepare(`SELECT plan_name FROM subscription WHERE provider_id = ? LIMIT 1`).get(providerId) as
      | { plan_name: string }
      | undefined)?.plan_name ??
    '未命名计划'

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
      // 计划改名必须把历史表一起带走：usage_daily / quota_window 的主键含 plan_name，
      // 只改 subscription 会让同一天的数据在新旧两个计划名下各存一份，求和直接翻倍
      if (has.plan_name !== result.plan.name) {
        renamePlan(db, providerId, has.plan_name, result.plan.name)
      }
    } else {
      db.prepare(
        `INSERT INTO subscription (provider_id, plan_name, price, currency, renewal_date, auto_renew, unknown_fields) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        providerId,
        result.plan.name,
        result.plan.unknownFields?.includes('price') ? null : (result.plan.price ?? 0),
        result.plan.currency ?? 'CNY',
        result.plan.unknownFields?.includes('renewalDate') ? null : (result.plan.renewalDate ?? null),
        result.plan.unknownFields?.includes('autoRenew') ? null : result.plan.autoRenew ? 1 : 0,
        result.plan.unknownFields?.join(',') ?? ''
      )
    }
    // 采集不到的字段置 NULL 并记录标记，前端红色标「未获取到」；
    // 换采集方式（如加浏览器登录）后拿到真值时插件传 [] 清除
    if (result.plan.unknownFields !== undefined) {
      // set 里是字面量 `col = NULL` 赋值，只有 unknown_fields 一个占位符
      const set: string[] = []
      for (const f of result.plan.unknownFields) {
        if (f === 'price') set.push('price = NULL')
        if (f === 'renewalDate') set.push('renewal_date = NULL')
        if (f === 'autoRenew') set.push('auto_renew = NULL')
      }
      set.push('unknown_fields = ?')
      db.prepare(`UPDATE subscription SET ${set.join(', ')} WHERE provider_id = ? AND plan_name = ?`).run(
        result.plan.unknownFields.join(','),
        providerId,
        result.plan.name
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(provider_id, plan_name, name) DO UPDATE SET
           used_pct = excluded.used_pct, used_value = excluded.used_value, limit_value = excluded.limit_value,
           unit = excluded.unit, reset_at = excluded.reset_at, extra_usage_enabled = excluded.extra_usage_enabled,
           updated_at = datetime('now')`
      ).run(
        providerId,
        planName,
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

  // 声明为区间快照的用量：先删区间内旧行（含其他计划名），再整体写入。
  // 插件把按量行改挂到独立计划名（plan/API 分流）后，不删旧行会双倍计数
  if (result.usageDaily?.length && result.usageWindow) {
    db.prepare(`DELETE FROM usage_daily WHERE provider_id = ? AND date >= ? AND date <= ?`).run(
      providerId,
      result.usageWindow.from,
      result.usageWindow.to
    )
  }

  for (const u of result.usageDaily ?? []) {
    db.prepare(
      `INSERT INTO usage_daily (provider_id, plan_name, date, input_tokens, output_tokens, cached_tokens, requests, cost_amount, cost_currency, source, billing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?)
       ON CONFLICT(provider_id, plan_name, date) DO UPDATE SET
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens,
         requests = excluded.requests, cost_amount = excluded.cost_amount, cost_currency = excluded.cost_currency,
         billing = excluded.billing`
    ).run(
      providerId,
      u.planName ?? planName,
      u.date,
      u.inputTokens ?? 0,
      u.outputTokens ?? 0,
      u.cachedTokens ?? 0,
      u.requests ?? 0,
      u.costAmount ?? 0,
      u.currency ?? 'CNY',
      u.billing ?? null
    )
  }

  // 余额差分必须在按日用量写入之后：它按 (provider, plan, date) 补当日 cost，
  // 先跑会被插件的 0 费用行整行覆盖。只在本次采集没带【按日消费】时启用，
  // 避免与真实费用重复计数；token 数无法由余额推出，留 0
  if (result.balance && !result.usageDaily?.some((u) => (u.costAmount ?? 0) > 0)) {
    deriveDailySpend(db, providerId, planName, result.balance, (result.notes ??= []))
  }

  if (result.modelUsage?.length && result.modelUsageWindow) {
    db.prepare(`DELETE FROM usage_model_daily WHERE provider_id = ? AND date >= ? AND date <= ?`).run(
      providerId,
      result.modelUsageWindow.from,
      result.modelUsageWindow.to
    )
  }

  for (const m of result.modelUsage ?? []) {
    db.prepare(
      `INSERT OR REPLACE INTO usage_model_daily (provider_id, date, model_id, input_tokens, output_tokens, cached_tokens, thinking_tokens, requests, errors, billing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      providerId,
      m.date,
      m.modelId,
      m.inputTokens ?? 0,
      m.outputTokens ?? 0,
      m.cachedTokens ?? 0,
      m.thinkingTokens ?? 0,
      m.requests ?? 0,
      m.errors ?? 0,
      m.billing ?? null
    )
  }

  // 可用模型是「当前状态」快照：整体替换，上游下架的模型才能消失
  if (result.availableModels !== undefined) {
    db.prepare(`DELETE FROM available_model WHERE provider_id = ?`).run(providerId)
    const ins = db.prepare(`INSERT OR REPLACE INTO available_model (provider_id, model_id) VALUES (?, ?)`)
    for (const m of [...new Set(result.availableModels)]) ins.run(providerId, m)
  }
}

export async function runProviderSync(providerId: string): Promise<SyncOutcome> {
  const db = getDb()
  const started = Date.now()

  const provider = db
    .prepare(`SELECT id, plugin_id, display_name FROM provider WHERE id = ?`)
    .get(providerId) as { id: string; plugin_id: string; display_name: string } | undefined
  if (!provider) {
    return { providerId, ok: false, mode: 'unconfigured', error: '供应商不存在' }
  }

  const plugin = getPlugin(provider.plugin_id)
  const cred = loadCredential(providerId)

  if (!plugin || !cred) {
    const reason = !plugin ? `插件未实现：${provider.plugin_id}` : '未配置凭证'
    db.prepare(`INSERT INTO sync_log (provider_id, status, duration_ms, error_type, error_msg) VALUES (?, 'failed', ?, 'not_configured', ?)`)
      .run(providerId, Date.now() - started, reason)
    return { providerId, ok: false, mode: 'unconfigured', error: reason }
  }

  try {
    const logs: string[] = []
    const result = await plugin.fetch(
      {
        providerId,
        dataDir: process.env.DATA_DIR || '.data',
        log: (m) => logs.push(m),
        loadCredential: (kind?: string) => loadCredential(providerId, kind),
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
