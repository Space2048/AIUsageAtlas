// 数据层：直连 Nuxt 服务的 REST 读取 + 轮询。
// 服务端生成的 DashboardData 已是扁平 VM，客户端零拼装。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import type { DashboardData } from '../../shared/types'
import { isNative, broadcast, onBroadcast } from './tauri'

const BASE_KEY = 'atlas-server'
const DEFAULT_BASE = 'http://127.0.0.1:3000'

export function getBase(): string {
  return (localStorage.getItem(BASE_KEY) || DEFAULT_BASE).replace(/\/+$/, '')
}

export function setBase(v: string) {
  localStorage.setItem(BASE_KEY, v.trim().replace(/\/+$/, '') || DEFAULT_BASE)
}

async function req(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${getBase()}${path}`, {
      cache: 'no-store',
      signal: ctrl.signal,
      ...init,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchDashboard(): Promise<DashboardData> {
  const res = await req('/api/dashboard')
  return (await res.json()) as DashboardData
}

// POST /api/sync 服务端串行阻塞执行，大账号可能要几十秒——超时放宽到 5 分钟
export async function postSync(): Promise<void> {
  await req(
    '/api/sync',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    300_000,
  )
}

export async function openDashboard() {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(getBase())
  } catch {
    window.open(getBase(), '_blank')
  }
}

const errText = (e: unknown) =>
  e instanceof Error
    ? e.name === 'AbortError'
      ? '请求超时'
      : e.message
    : String(e)

export function useDashboard(intervalMs = 60_000) {
  const data = ref<DashboardData | null>(null)
  const error = ref('')
  const loading = ref(true)
  const lastOk = ref(0) // 最近一次成功拉取的时间戳，球上「数据过期」判定用
  const syncing = ref(false)

  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false

  async function load() {
    if (inFlight) return
    inFlight = true
    try {
      data.value = await fetchDashboard()
      error.value = ''
      lastOk.value = Date.now()
    } catch (e) {
      error.value = errText(e)
    } finally {
      loading.value = false
      inFlight = false
    }
  }

  async function sync() {
    if (syncing.value) return
    syncing.value = true
    try {
      await postSync()
      await load()
      // 同步是全局动作，广播让另一个窗口也立即刷新
      broadcast('atlas-reload')
    } catch (e) {
      error.value = errText(e)
    } finally {
      syncing.value = false
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') load()
  }

  onMounted(() => {
    load()
    timer = setInterval(load, intervalMs)
    document.addEventListener('visibilitychange', onVisible)
    onBroadcast('atlas-reload', load)
  })

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  })

  return { data, error, loading, lastOk, syncing, load, sync }
}

export function iconUrl(icon: string): string {
  return icon ? `${getBase()}/${icon.replace(/^\/+/, '')}` : ''
}

export { isNative }
