import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  vite: {
    server: {
      fs: {
        allow: [fileURLToPath(new URL('.', import.meta.url))],
      },
    },
  },
  runtimeConfig: {
    dataDir: process.env.DATA_DIR || '.data',
  },
})
