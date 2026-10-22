import { listPlugins } from '~~/server/providers'
import type { PluginMeta } from '~~/shared/types'

export default defineEventHandler((): PluginMeta[] =>
  listPlugins().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    icon: p.icon,
    category: 'subscription',
    authKinds: p.authMethods,
    homepage: p.homepage ?? '',
    scheduleDefaultSec: p.scheduleDefaultSec,
    cookieGuide: p.cookieGuide,
    sites: p.sites,
  }))
)
