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
# 前置：本机 Nuxt 服务跑在 127.0.0.1:3000；Rust 已装（rustup 默认 MSVC 工具链）
cd desktop
npm install
scripts\tauri-dev.bat  # 等价于 npm run tauri dev，但先加载 VS2019 vcvars64
# 若直接 npm run tauri dev 报 link.exe/kernel32.lib 错，说明 shell 里没有 MSVC 环境
```

> 本机注意：`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` 是一次
> 中断安装留下的非空残骸，VS 安装器拒绝写入（无法补装 2022）；**2019 BuildTools 的
> v142 工具链完整**，三个 .bat 包装脚本都指向它。**cmd 打开的 .bat 注释必须纯 ASCII**
> （cmd 按 GBK 解码，UTF-8 中文注释会被当命令执行）。

纯浏览器调试（不开 Rust）：`npm run dev` 后访问 `http://127.0.0.1:1420/`（球在左上角，
`?view=panel` 单独看面板）。

**热更新边界**：`.vue` 组件改动会走 vite 组件热替换（webview 即时生效）；但
`tauri.ts` / `api.ts` 这类非组件模块的改动需要**整页 reload，Tauri webview 收不到**
——改完必须重启 `tauri-dev.bat`，否则 webview 里跑的是旧模块（会出现
`xxx is not a function` 之类的隐性错乱）。

## 打包

```bash
cd desktop
scripts\tauri-build.bat  # 产出 src-tauri/target/release/bundle/nsis/*.exe 与 msi/*.msi
```

图标源变更时：改根目录 `public/icon.svg` → `node scripts/gen-icon-source.mjs`
（用根目录的 playwright）→ `npx tauri icon src-tauri/icons/icon-source.png`。

## 行为说明

- **单击球**：展开/收起面板；**双击球**：收起面板并打开 Web 仪表盘；**拖拽球**：移动
  （位置存 localStorage，重启恢复并夹回屏幕内）。拖拽是 JS 驱动（`cursorPosition` +
  `setPosition` 跟随光标）——`data-tauri-drag-region` 的 WM_NCLBUTTONDOWN/HTCAPTION
  对无边框窗口不生效；按下期间的位置采样同时充当「拖拽≠点击」守卫。
- **贴边磁吸**：拖拽时距显示器工作区边缘 28px 内自动吸上（完全贴边、支持四边与角落、
  跨屏跟随光标所在屏），拖拽全程夹紧在工作区内不许出屏。
- **边缘收纳**：停靠在边上的球，鼠标移开后 0.8s 自动滑出屏幕，留 34px 边条
  （≈ 球体月牙形凸起 18px，作为「球停在这」的可视提示；rAF 缓动 240ms）；
  鼠标碰到边条滑回屏内（260ms），再移开又收回。启动时若上次位置是贴边的，
  直接以收起态出现。`tauri.ts` 里 `HIDE_VISIBLE/REHIDE_DELAY` 可调
  （注意 HIDE_VISIBLE 是窗口边条，必须 > 球体到窗口边的距离 16px 才能看到球体）。
- **拖球收面板**：面板开着时拖动悬浮球，面板立即播退场动画并收起。
- **面板动画**：展开 = 上浮淡入（220ms，锚点靠球一侧），收起 = 下沉淡出（150ms），
  播完才真正 hide 窗口；原生面板窗口 DOM 复用，用 openKey 重挂载卡片重放入场动画。
- **面板**：失焦 130ms 后自动隐藏（点球瞬间会先撤销该隐藏，避免闪烁）；Esc / × 手动关。
- **托盘**：左键=切换单词板，右键菜单=打开仪表盘 / 立即同步 / 退出。
- **数据**：60s 轮询；面板「同步全部」= `POST /api/sync`（服务端串行，可能十几秒），
  完成后广播 `atlas-reload` 让两个窗口同时刷新；数据 >30 分钟没拉到 → 球上灰色过期角标；
  拉取失败 → 球变暗显示 `!`，面板显示「服务未连接」+ 重试。
- **连接设置**：面板齿轮里改服务器地址（默认 `http://127.0.0.1:3000`），存 localStorage。
- **窗口几何**：Windows DefWindowProc 会把窗口钳到 `SM_CXMINTRACK`（本机 136px），
  小窗在创建期配置 minWidth 压不住——`main.rs` setup 里运行时
  `set_min_size` + `set_size` 修正（现为 104×104：球体 72 + 光晕余量）。
  **方形外框坑（两个来源都要关）**：① CSS 光晕的总伸展（半径+偏移+模糊）必须 ≤ 窗口半宽，
  否则被方形窗口边界裁出边缘线；② Win11 给无边框窗口合成的 DWM 方形阴影——
  `shadow:false` 配置压不住，`main.rs` 的 `kill_dwm_shadow()` 设
  `DWMWA_WINDOW_CORNER_PREFERENCE=DWMWCP_DONOTROUND` 即可（阴影随圆角而来，windows-sys
  feature 名是 `Win32_Graphics_Dwm`）。**两个禁操作**：不要设
  `DWMWA_NCRENDERING_POLICY=DISABLED`（系统会回退传统绘制、画出可见标题栏）；
  不要调 `set_shadow(false)`（tao 借机重放窗口样式，可能把 decorations:false 挤掉）。
- **诊断通道**：`diag` 命令把前端关键事件打进 tauri dev 控制台
  （`tauri.ts` 的 `diag()`，自定义命令在 Tauri 2 默认放行，无需 ACL 条目）。

## 已知边界（后续阶段）

- 无鉴权：当前服务端本就没有 Bearer 校验（`api_token` 表只存不验），远程服务器场景
  需要先实现鉴权中间件再把地址指向外网。
- 同一端口多开由单实例插件挡住；开机自启、告警通知未做。
