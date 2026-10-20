import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// 每个供应商一个独立的持久浏览器 profile 目录
export function profileDir(dataDir: string, providerId: string): string {
  return join(dataDir, 'browser-profiles', providerId)
}

export function ensureProfileDir(dataDir: string, providerId: string): string {
  const dir = profileDir(dataDir, providerId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function hasProfile(dataDir: string, providerId: string): boolean {
  return existsSync(profileDir(dataDir, providerId))
}

export function markLoggedIn(dataDir: string, providerId: string) {
  const dir = ensureProfileDir(dataDir, providerId)
  writeFileSync(join(dir, '.logged-in'), new Date().toISOString())
}

export function isLoggedIn(dataDir: string, providerId: string): boolean {
  return existsSync(join(profileDir(dataDir, providerId), '.logged-in'))
}

export function clearProfile(dataDir: string, providerId: string) {
  rmSync(profileDir(dataDir, providerId), { recursive: true, force: true })
}

// 从 JWT 里解出过期时间（秒），失败返回 undefined
export function jwtExpMs(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
