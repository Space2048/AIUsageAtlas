import { getDb } from '~~/server/utils/db'
import type { ModelPriceRow } from '~~/shared/types'

export default defineEventHandler((): { prices: ModelPriceRow[]; sources: string[] } => {
  const db = getDb()
  const prices = (
    db
      .prepare(
        `SELECT provider_id, model_id, source, currency, input_per_m, output_per_m, cached_read_per_m, cached_write_per_m, context_window, effective_from
         FROM model_price ORDER BY provider_id, model_id, effective_from DESC`
      )
      .all() as Array<Record<string, never>>
  ).map((r) => ({
    providerId: r.provider_id,
    modelId: r.model_id,
    source: r.source,
    currency: r.currency,
    inputPerM: r.input_per_m,
    outputPerM: r.output_per_m,
    cachedReadPerM: r.cached_read_per_m,
    cachedWritePerM: r.cached_write_per_m,
    contextWindow: r.context_window,
    effectiveFrom: r.effective_from,
  }))

  const sources = [...new Set(prices.map((p) => p.source))]
  return { prices, sources }
})
