import type { DatabaseSync } from 'node:sqlite'

const PROVIDERS = [
  { id: 'deepseek', pluginId: 'deepseek', displayName: 'DeepSeek', category: 'api', icon: '/icons/deepseek.svg' },
  { id: 'bigmodel', pluginId: 'bigmodel', displayName: 'BigModel 智谱', category: 'api', icon: '/icons/bigmodel.png' },
  { id: 'stepfun', pluginId: 'stepfun', displayName: 'StepFun 阶跃星辰', category: 'subscription', icon: '/icons/stepfun.png' },
  { id: 'xiaomimo', pluginId: 'xiaomimo', displayName: 'Xiaomi MiMo', category: 'subscription', icon: '/icons/xiaomimo.ico' },
  { id: 'opencode', pluginId: 'opencode', displayName: 'OpenCode Zen', category: 'aggregate', icon: '/icons/opencode.png' },
]

// 官方核实的模型价目：[provider, model, currency, 输入/百万, 输出/百万, 缓存命中/百万]
// cached_write 与 context_window 官方未公布，留 0 表示未知
const OFFICIAL_PRICES: Array<[string, string, string, number, number, number]> = [
  ['xiaomimo', 'mimo-v2.6-pro', 'CNY', 3, 6, 0.025],
  ['xiaomimo', 'mimo-v2.6-flash', 'CNY', 1, 2, 0.02],
  ['xiaomimo', 'mimo-v2.6-pro-ultraspeed', 'CNY', 30, 60, 0.25],
]

interface SeedSpec {
  providerId: string
  userName: string
  maskedContact: string
  region: string
  planName: string
  price: number
  currency: string
  renewalDays: number
  autoRenew: number
  balance: number | null
  windows: Array<{ name: string; usedPct: number; resetInSec: number; extra?: boolean }>
  usagePattern: { base: number; models: Array<[string, number]> }
  scheduleSec: number
}

const SEEDS: SeedSpec[] = [
  {
    providerId: 'deepseek',
    userName: 'devel',
    maskedContact: 'de****@gmail.com',
    region: 'CN',
    planName: '按量付费',
    price: 0,
    currency: 'CNY',
    renewalDays: -1,
    autoRenew: 0,
    balance: 52.4,
    windows: [{ name: '日额度', usedPct: 34, resetInSec: 5 * 3600 }],
    usagePattern: { base: 4_200_000, models: [['deepseek-chat', 70], ['deepseek-reasoner', 30]] },
    scheduleSec: 1800,
  },
  {
    providerId: 'bigmodel',
    userName: 'zhipu_dev',
    maskedContact: 'z***@bigmodel.cn',
    region: 'CN',
    planName: 'GLM Coding Plan 季卡',
    price: 198,
    currency: 'CNY',
    renewalDays: 17,
    autoRenew: 1,
    balance: 128.0,
    windows: [
      { name: '5小时窗口', usedPct: 62, resetInSec: 2 * 3600 + 42 * 60, extra: true },
      { name: '周窗口', usedPct: 48, resetInSec: 3 * 86400 },
      { name: '月窗口', usedPct: 71, resetInSec: 12 * 86400 },
    ],
    usagePattern: { base: 12_600_000, models: [['glm-4.6', 55], ['glm-4.5-air', 45]] },
    scheduleSec: 900,
  },
  {
    providerId: 'stepfun',
    userName: 'step_user',
    maskedContact: 's***@stepfun.com',
    region: 'CN',
    planName: 'Step-3 体验套餐',
    price: 49,
    currency: 'CNY',
    renewalDays: 6,
    autoRenew: 0,
    balance: null,
    windows: [
      { name: '日额度', usedPct: 88, resetInSec: 9 * 3600 },
      { name: '月额度', usedPct: 40, resetInSec: 21 * 86400 },
    ],
    usagePattern: { base: 1_800_000, models: [['step-3', 100]] },
    scheduleSec: 3600,
  },
  {
    providerId: 'xiaomimo',
    userName: 'mimo_user',
    maskedContact: 'm***@xiaomi.com',
    region: 'CN',
    planName: 'Token Plan Standard',
    price: 99,
    currency: 'CNY',
    renewalDays: 26,
    autoRenew: 1,
    balance: null,
    windows: [{ name: '套餐周期 Credits', usedPct: 62, resetInSec: 26 * 86400 }],
    usagePattern: { base: 640_000, models: [['mimo-v2.6-pro', 70], ['mimo-v2.6-flash', 30]] },
    scheduleSec: 3600,
  },
  {
    providerId: 'opencode',
    userName: 'oc_dev',
    maskedContact: 'o***@opencode.ai',
    region: 'US',
    planName: 'Zen Starter',
    price: 10,
    currency: 'USD',
    renewalDays: 2,
    autoRenew: 1,
    balance: 6.35,
    windows: [{ name: '月度额度', usedPct: 36, resetInSec: 28 * 86400 }],
    usagePattern: { base: 3_100_000, models: [['claude-sonnet-4.5', 40], ['kimi-k2', 35], ['qwen3-coder', 25]] },
    scheduleSec: 600,
  },
]

function isoIn(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString()
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString()
}

function dateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  return d.toISOString().slice(0, 10)
}

export function seedIfEmpty(d: DatabaseSync) {
  // 官方图标回填（对已存在的库也生效）
  const upsertIcon = d.prepare(`UPDATE provider SET icon = ? WHERE plugin_id = ? AND (icon IS NULL OR icon = '')`)
  for (const p of PROVIDERS) upsertIcon.run(p.icon, p.pluginId)

  // 已核实渠道的官方价目（mimo.mi.com/docs/zh-CN/price/pay-as-you-go，2026-10-08 口径）
  // 只在缺行时插入，不覆盖：调价由后续价格刷新流程写新的 effective_from 版本
  const insOfficialPrice = d.prepare(
    `INSERT INTO model_price (provider_id, model_id, source, currency, input_per_m, output_per_m, cached_read_per_m, cached_write_per_m, context_window)
     SELECT ?, ?, 'official', ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM model_price WHERE provider_id = ? AND model_id = ? AND source = 'official')`
  )
  for (const [prov, model, cur, i, o, cr] of OFFICIAL_PRICES) {
    insOfficialPrice.run(prov, model, cur, i, o, cr, 0, 0, prov, model)
  }
  // 早期 mock 的 mimo-v2 已下架且价格不对，官方行落库后清掉
  d.prepare(`DELETE FROM model_price WHERE provider_id = 'xiaomimo' AND model_id = 'mimo-v2' AND source = 'litellm'`).run()

  // 同理修正已落库的 MiMo mock 套餐：平台没有免费档，只有 ¥5 新用户赠金 + Token Plan
  d.prepare(
    `UPDATE subscription SET plan_name = 'Token Plan Standard', price = 99, auto_renew = 1,
       renewal_date = date('now', '+26 days')
     WHERE provider_id = 'xiaomimo' AND plan_name = 'MiMo 免费额度'`
  ).run()
  d.prepare(
    `UPDATE quota_window SET name = '套餐周期 Credits', used_pct = 62, reset_at = datetime('now', '+26 days')
     WHERE provider_id = 'xiaomimo' AND name = '日额度'`
  ).run()
  d.prepare(`UPDATE usage_model_daily SET model_id = 'mimo-v2.6-pro' WHERE provider_id = 'xiaomimo' AND model_id = 'mimo-v2'`).run()

  const row = d.prepare('SELECT COUNT(*) AS n FROM provider').get() as { n: number }
  if (row.n > 0) return

  const insProvider = d.prepare(
    `INSERT OR IGNORE INTO provider (id, plugin_id, display_name, category, icon) VALUES (?, ?, ?, ?, ?)`
  )
  const insProfile = d.prepare(
    `INSERT OR REPLACE INTO account_profile (provider_id, user_name, masked_contact, region, avatar_text) VALUES (?, ?, ?, ?, ?)`
  )
  const insSub = d.prepare(
    `INSERT OR REPLACE INTO subscription (provider_id, plan_name, price, currency, renewal_date, auto_renew) VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insWindow = d.prepare(
    `INSERT OR REPLACE INTO quota_window (provider_id, plan_name, name, used_pct, used_value, limit_value, unit, reset_at, extra_usage_enabled) VALUES (?, ?, ?, ?, NULL, NULL, 'pct', ?, ?)`
  )
  const insUsage = d.prepare(
    `INSERT OR REPLACE INTO usage_daily (provider_id, plan_name, date, input_tokens, output_tokens, cached_tokens, requests, cost_amount, cost_currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insBalance = d.prepare(
    `INSERT OR REPLACE INTO balance_snapshot (provider_id, date, balance, currency) VALUES (?, ?, ?, ?)`
  )
  const insSyncCfg = d.prepare(
    `INSERT OR REPLACE INTO sync_config (provider_id, enabled, interval_sec) VALUES (?, 1, ?)`
  )
  const insSyncLog = d.prepare(
    `INSERT INTO sync_log (provider_id, status, duration_ms) VALUES (?, 'ok', ?)`
  )

  for (const p of PROVIDERS) insProvider.run(p.id, p.pluginId, p.displayName, p.category, p.icon)

  for (const s of SEEDS) {
    insProfile.run(s.providerId, s.userName, s.maskedContact, s.region, s.userName.slice(0, 2).toUpperCase())
    insSub.run(
      s.providerId,
      s.planName,
      s.price,
      s.currency,
      s.renewalDays >= 0 ? isoInDays(s.renewalDays).slice(0, 10) : null,
      s.autoRenew
    )
    for (const w of s.windows) {
      insWindow.run(s.providerId, s.planName, w.name, w.usedPct, isoIn(w.resetInSec), w.extra ? 1 : 0)
    }
    if (s.balance !== null) insBalance.run(s.providerId, dateStr(), s.balance, s.currency)

    insSyncCfg.run(s.providerId, s.scheduleSec)
    insSyncLog.run(s.providerId, 400 + Math.floor(Math.random() * 1500))

    const models = s.usagePattern.models
    const totalShare = models.reduce((a, [, w]) => a + w, 0)
    const dayFactors = [1, 0.82, 1.15, 0.6, 0.95, 1.3, 0.45, 0.7, 1.05, 0.88, 1.22, 0.5, 0.9, 1.1,
      0.65, 1.0, 0.78, 1.35, 0.55, 0.92, 1.08, 0.7, 1.18, 0.62, 0.85, 1.02, 0.75, 1.25, 0.48, 0.98]
    for (let i = 0; i < 30; i++) {
      const date = dateStr(-i)
      const tokens = Math.round(s.usagePattern.base * (dayFactors[i] ?? 1))
      const input = Math.round(tokens * 0.72)
      const output = Math.round(tokens * 0.28)
      const costRate = s.currency === 'USD' ? 0.0000028 : 0.0000016
      const cost = Number((tokens * costRate).toFixed(4))
      insUsage.run(s.providerId, s.planName, date, input, output, 0, Math.round(tokens / 4000), cost, s.currency)
      for (const [modelId, weight] of models) {
        const acc = Math.round((tokens * weight) / totalShare)
        d.prepare(
          `INSERT OR REPLACE INTO usage_model_daily (provider_id, date, model_id, input_tokens, output_tokens, requests) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(s.providerId, date, modelId, Math.round(acc * 0.7), Math.round(acc * 0.3), Math.round(acc / 4000))
      }
    }
  }

  // 模型价格表（LiteLLM 口径的 mock 快照）
  const insPrice = d.prepare(
    `INSERT OR REPLACE INTO model_price (provider_id, model_id, source, currency, input_per_m, output_per_m, cached_read_per_m, cached_write_per_m, context_window) VALUES (?, ?, 'litellm', ?, ?, ?, ?, ?, ?)`
  )
  const PRICES: Array<[string, string, string, number, number, number, number, number]> = [
    ['deepseek', 'deepseek-chat', 'USD', 0.27, 1.1, 0.07, 0.07, 128000],
    ['deepseek', 'deepseek-reasoner', 'USD', 0.55, 2.19, 0.14, 0.14, 128000],
    ['bigmodel', 'glm-4.6', 'USD', 1.5, 6, 0.3, 0.3, 200000],
    ['bigmodel', 'glm-4.5-air', 'USD', 0.5, 2, 0.1, 0.1, 128000],
    ['stepfun', 'step-3', 'CNY', 4, 16, 1, 1, 128000],
    ['opencode', 'claude-sonnet-4.5', 'USD', 3, 15, 0.3, 3.75, 200000],
    ['opencode', 'kimi-k2', 'USD', 0.6, 2.5, 0.15, 0.15, 256000],
    ['opencode', 'qwen3-coder', 'USD', 0.3, 1.2, 0.06, 0.06, 262144],
    ['litellm', 'gpt-5.6', 'USD', 2, 12, 0.5, 0.5, 272000],
    ['litellm', 'claude-opus-5', 'USD', 5, 25, 0.5, 6.25, 200000],
    ['litellm', 'gemini-3-pro', 'USD', 2, 12, 0.5, 0.5, 1048576],
    ['litellm', 'qwen3-max', 'CNY', 2.4, 9.6, 0.48, 0.48, 262144],
  ]
  for (const [prov, model, cur, i, o, cr, cw, ctx] of PRICES) {
    insPrice.run(prov, model, cur, i, o, cr, cw, ctx)
  }

  // 访问令牌（mock）
  d.prepare(`INSERT OR REPLACE INTO api_token (id, name, token_hash) VALUES (1, '本地客户端', 'dev-token-atlas-0001')`).run()

  // 全局设置
  const insSetting = d.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
  insSetting.run('display_currency', 'CNY')
  insSetting.run('fx_rate', '7.1')
  insSetting.run('timezone', 'Asia/Shanghai')

  // 同步历史日志
  const insLog2 = d.prepare(
    `INSERT INTO sync_log (provider_id, started_at, status, duration_ms, error_type, error_msg) VALUES (?, datetime('now', ?), ?, ?, ?, ?)`
  )
  for (const s of SEEDS) {
    insLog2.run(s.providerId, `-${1 * s.scheduleSec / 60 + 3} minutes`, 'ok', 500 + Math.floor(Math.random() * 900), null, null)
    insLog2.run(s.providerId, `-${3 * s.scheduleSec / 60 + 5} minutes`, 'ok', 500 + Math.floor(Math.random() * 900), null, null)
    insLog2.run(s.providerId, `-${5 * s.scheduleSec / 60 + 8} minutes`, 'ok', 500 + Math.floor(Math.random() * 900), null, null)
  }
  insLog2.run('stepfun', '-9 hours', 'failed', 820, 'endpoint_changed', '控制台接口返回 404，等待插件更新')

  d.prepare(`INSERT OR IGNORE INTO alert_rule (provider_id, metric, threshold) VALUES ('bigmodel', 'used_pct', 90)`).run()
  d.prepare(`INSERT OR IGNORE INTO alert_rule (provider_id, metric, threshold) VALUES ('deepseek', 'balance', 20)`).run()
}
