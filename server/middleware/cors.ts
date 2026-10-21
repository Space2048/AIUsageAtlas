// 桌面悬浮球客户端（Tauri WebView2，origin 为 http://tauri.localhost / tauri://localhost）
// 以及本地 dev 前端跨域访问 /api/* 的放行。单用户内网工具，按架构文档「仅局域网/内网部署」前提放开 *。
export default defineEventHandler((event) => {
  setHeader(event, 'Access-Control-Allow-Origin', '*')
  setHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  setHeader(event, 'Access-Control-Allow-Headers', 'Content-Type, Authorization')
  setHeader(event, 'Access-Control-Max-Age', '86400')
  if (event.method === 'OPTIONS') {
    return sendNoContent(event, 204)
  }
})
