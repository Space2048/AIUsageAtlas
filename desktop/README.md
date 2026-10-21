# AIUsageAtlas 桌面悬浮球（Tauri 2 · Windows）

常驻桌面的悬浮球客户端：球体显示**今日费用 / 今日 Token**，点击展开迷你面板查看
各渠道**额度条、重置倒计时、续费日、余额**并可手动同步；双击球打开 Web 仪表盘。
数据源就是本项目的 `GET /api/dashboard`，服务端唯一配套改动是 `server/middleware/cors.ts`。

## 目录

```
desktop/
├── src/                    # Vue 3 + TS 前端（独立于 Nuxt）
│   ├── App.vue             # 窗口角色路由：ball / panel / 浏览器调试
│   ├── components/Ball.vue # 悬浮球（76×76 透明置顶窗）
│   ├── components/Panel.vue# 展开面板（360×480，点球弹出、失焦隐藏）
│   ├── api.ts              # REST 读取 + 60s 轮询 + 手动同步
│   ├── tauri.ts            # 原生桥接（窗口显隐/定位/拖拽守卫/托盘事件）
│   └── utils.ts            # 与主站同口径的格式化（UTC 日、K/M/B、三档阈值色）
├── src-tauri/
│   ├── src/main.rs         # Rust 只做窗口/托盘/单实例，业务全走前端事件
│   ├── tauri.conf.json     # 双窗口 + NSIS/MSI 打包配置
│   ├── capabilities/       # ACL 权限（拖拽/显隐/定位/事件/打开链接）
│   └── icons/              # 由 public/icon.svg 派生（npx tauri icon）
└── scripts/gen-icon-source.mjs
```

## 开发

```bash
# 前置：本机 Nuxt 服务跑在 127.0.0.1:3000；Rust + VS Build Tools (VCTools) 已装
cd desktop
npm install
npm run tauri dev      # 起 vite(127.0.0.1:1420) + 编译并拉起原生窗口
```

纯浏览器调试（不开 Rust）：`npm run dev` 后访问 `http://127.0.0.1:1420/`（球在左上角，
`?view=panel` 单独看面板）。

## 打包

```bash
cd desktop
npm run tauri build    # 产出 src-tauri/target/release/bundle/nsis/*.exe 与 msi/*.msi
```

图标源变更时：改根目录 `public/icon.svg` → `node scripts/gen-icon-source.mjs`
（用根目录的 playwright）→ `npx tauri icon src-tauri/icons/icon-source.png`。

## 行为说明

- **单击球**：展开/收起面板；**双击球**：收起面板并打开 Web 仪表盘；**拖拽球**：移动
  （位置存 localStorage，重启恢复并夹回屏幕内）。
- **面板**：失焦 130ms 后自动隐藏（点球瞬间会先撤销该隐藏，避免闪烁）；Esc / × 手动关。
- **托盘**：左键=切换单词板，右键菜单=打开仪表盘 / 立即同步 / 退出。
- **数据**：60s 轮询；面板「同步全部」= `POST /api/sync`（服务端串行，可能十几秒），
  完成后广播 `atlas-reload` 让两个窗口同时刷新；数据 >30 分钟没拉到 → 球上灰色过期角标；
  拉取失败 → 球变暗显示 `!`，面板显示「服务未连接」+ 重试。
- **连接设置**：面板齿轮里改服务器地址（默认 `http://127.0.0.1:3000`），存 localStorage。

## 已知边界（后续阶段）

- 无鉴权：当前服务端本就没有 Bearer 校验（`api_token` 表只存不验），远程服务器场景
  需要先实现鉴权中间件再把地址指向外网。
- 同一端口多开由单实例插件挡住；开机自启、告警通知未做。
