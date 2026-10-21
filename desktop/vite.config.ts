import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// 悬浮球前端：Vite 独立于 Nuxt，dev 端口固定 1420（Tauri devUrl 约定）
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
    // 共享类型在仓库根 shared/ 下，允许跨出 desktop/ 读取
    fs: { allow: [resolve(__dirname, '..')] },
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
