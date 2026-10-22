import type { ProviderPlugin } from './types'
import { bigmodelPlugin } from './bigmodel'
import { deepseekPlugin } from './deepseek'
import { opencodePlugin } from './opencode'
import { qoderPlugin } from './qoder'
import { stepfunPlugin } from './stepfun'
import { tongyiPlugin } from './tongyi'
import { traePlugin } from './trae'
import { volcenginePlugin } from './volcengine'
import { xiaomimoPlugin } from './xiaomimo'

// 渠道插件注册表：新增渠道 = 新建插件文件并在这里登记
const plugins: ProviderPlugin[] = [
  stepfunPlugin,
  xiaomimoPlugin,
  deepseekPlugin,
  bigmodelPlugin,
  opencodePlugin,
  tongyiPlugin,
  volcenginePlugin,
  traePlugin,
  qoderPlugin,
]

export function getPlugin(id: string): ProviderPlugin | undefined {
  return plugins.find((p) => p.id === id)
}

export function listPlugins(): ProviderPlugin[] {
  return plugins
}
