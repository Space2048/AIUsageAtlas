import type { DatabaseSync } from 'node:sqlite'

/**
 * 官方核实的模型价目，随代码维护（不是演示数据）：
 * 来源 mimo.mi.com/docs/zh-CN/price/pay-as-you-go，2026-10-08 口径。
 * cached_write 与 context_window 官方未公布，留 0 表示未知。
 */
const OFFICIAL_PRICES: Array<[providerId: string, modelId: string, currency: string, input: number, output: number, cachedRead: number]> = [
  ['xiaomimo', 'mimo-v2.6-pro', 'CNY', 3, 6, 0.025],
  ['xiaomimo', 'mimo-v2.6-flash', 'CNY', 1, 2, 0.02],
  ['xiaomimo', 'mimo-v2.6-pro-ultraspeed', 'CNY', 30, 60, 0.25],
]

// 只在缺行时插入，不覆盖：调价由价格刷新流程写新的 effective_from 版本
export function applyOfficialPrices(d: DatabaseSync) {
  const ins = d.prepare(
    `INSERT INTO model_price (provider_id, model_id, source, currency, input_per_m, output_per_m, cached_read_per_m, cached_write_per_m, context_window)
     SELECT ?, ?, 'official', ?, ?, ?, ?, 0, 0
     WHERE NOT EXISTS (SELECT 1 FROM model_price WHERE provider_id = ? AND model_id = ? AND source = 'official')`
  )
  for (const [providerId, modelId, currency, input, output, cachedRead] of OFFICIAL_PRICES) {
    ins.run(providerId, modelId, currency, input, output, cachedRead, providerId, modelId)
  }
}
