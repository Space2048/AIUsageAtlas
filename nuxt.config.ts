import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'AIUsageAtlas — AI 用量聚合',
      htmlAttrs: { lang: 'zh-CN' },
      link: [
        { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48' },
        { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
      ],
      meta: [{ name: 'theme-color', content: '#f7f5f0' }],
    },
  },
  // desktop/ 是 Tauri 客户端，它的 src-tauri/target 构建产物会被 cargo 长期锁住，
  // Nuxt 监视到 EBUSY 就整站重启，Web dev server 会被反复掀掉 —— 必须排除在监听之外
  watch: {
    ignore: ['**/desktop/**'],
  },
  vite: {
    server: {
      fs: {
        allow: [fileURLToPath(new URL('.', import.meta.url))],
      },
      watch: {
        ignored: ['**/node_modules/**', '**/desktop/**'],
      },
    },
  },
  runtimeConfig: {
    dataDir: process.env.DATA_DIR || '.data',
  },
})
