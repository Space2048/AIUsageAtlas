# AIUsageAtlas

<p align="center">
  <img src="public/icon.svg" width="96" alt="AIUsageAtlas 图标">
</p>

自托管的「AI 供应商额度与用量聚合器」：把各 AI 平台/代理平台的额度、配额窗口、订阅计划、每日用量和费用汇总到一个本地仪表盘。

## 功能

- **仪表盘**：今日 Token/费用汇总、30 天续费提醒、每渠道卡片（计划、余额、配额窗口倒计时、今日用量、迷你趋势）
- **供应商详情**：账户信息、计划与续费、配额窗口、近 30 日用量图、模型用量明细（含价格对照）、同步间隔配置、同步日志、删除
- **价格表**：模型输入/输出/缓存价格（LiteLLM 口径快照 + 渠道自带价格）
- **设置**：显示币种与汇率、时区、访问令牌管理、告警规则
- **桌面悬浮球**（Tauri 2 · Windows）：常驻置顶白瓷球显示今日费用/Token，单击展开分组面板，贴边收纳、开机自启
- 手动刷新（全局/单渠道），采集按渠道插件化、可配独立间隔

## 快速开始

### Docker 部署（推荐）

```bash
docker compose up -d
# 打开 http://localhost:3000
```

数据持久化在 `./data`（SQLite + 凭证）。

### 本地开发

```bash
npm install
npm run dev        # http://localhost:3000
```

> 注意：本项目锁定 `nuxt@3.18.1`。3.17.x 在部分环境 dev 模式有 module runner 403 问题，请勿随意升级。

## 桌面悬浮球客户端（Tauri 2 · Windows）

常驻桌面的悬浮球：白瓷球体显示**今日费用 / 今日 Token**，单击展开分组面板，双击打开 Web 仪表盘，
拖拽贴边自动收纳（悬停边条滑出）。

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/ball.png" width="130" alt="悬浮球"><br><sub>白瓷球 · 四态</sub></td>
    <td align="center"><img src="docs/screenshots/panel.png" width="250" alt="分组面板"><br><sub>置顶 + 全部渠道</sub></td>
    <td align="center"><img src="docs/screenshots/settings.png" width="250" alt="设置抽屉"><br><sub>设置抽屉</sub></td>
  </tr>
</table>

**能力一览**

- **悬浮球**：白瓷底 + 珊瑚费用数字；服务未连接 = 红描边 `!`，数据过期 = 灰点，贴边收起只留月牙
- **面板分组**：三格汇总条（费用/Token/数据时间）→「置顶」组（**自选最多 2 个**，第 3 个挤掉最早；展示全部额度窗口 + 余额 + 今日/同步脚注）→「全部渠道」单行（余额 · 最紧张百分比 · 紧凑倒计时 · 图钉，按紧张度降序）
- **设置抽屉**：服务器地址（输入即生效，带连接自检）、开机自启（写 `HKCU\Run`）、关于
- **交互**：贴边磁吸（距边缘 12px 内吸附，四边/角落/跨屏）+ 边缘收纳动画（800ms 延迟收回、悬停滑出）；面板弹出按球的方位选锚点回弹，点球球体同步弹跳
- **数据**：`GET /api/dashboard` 60s 轮询 + `POST /api/sync` 手动同步，与 Web 仪表盘同源同口径

```bash
cd desktop
npm install
scripts\tauri-dev.bat      # 开发（自动加载 VS2019 vcvars，勿用裸 npm run tauri dev）
scripts\tauri-exe.bat      # 只出 prod exe（tauri build --no-bundle）
scripts\tauri-build.bat    # 完整打包：NSIS 安装包 + MSI
```

> 设计细节与 Windows 坑位（SM_CXMINTRACK 钳宽、DWM 方形阴影、裸 cargo 编出 dev 空窗二进制、
> HTCAPTION 拖拽失效等）见 [desktop/README.md](desktop/README.md)。

## 目录结构

```
├── pages/               # 页面（仪表盘/详情/价格表/设置）
├── components/          # AppHeader 等
├── desktop/             # Tauri 2 桌面悬浮球（独立子项目，见 desktop/README.md）
├── docs/                # 架构/数据模型文档 + screenshots（README 配图）
├── public/              # 图标：icon.svg（矢量源）/ favicon.ico / apple-touch-icon.png
├── scripts/             # 诊断脚本与图标生成（node scripts/generate-icons.mjs）
├── server/
│   ├── api/             # REST 接口
│   ├── middleware/      # CORS 等（桌面客户端跨域依赖）
│   ├── providers/       # 渠道插件框架 + 各渠道实现
│   └── utils/           # SQLite 连接、建表、同步器、浏览器会话
├── shared/types.ts      # 前后端共享类型
└── assets/css/main.css  # 消费级明亮风设计系统
```

## 数据模型

15 张表的字段、ER 图、采集落库数据流与写入语义见 [docs/02-data-model.md](docs/02-data-model.md)；选型层面的说明在 [docs/01-architecture.md](docs/01-architecture.md) §2.2。

## 渠道插件

采集按渠道插件化，每个插件实现统一接口（`server/plugins/types.ts`）：

```ts
interface ProviderPlugin {
  id: string
  displayName: string
  authMethods: AuthKind[]      // 'apikey' | 'cookie' | 'browser-login'
  scheduleDefaultSec: number
  fetch(ctx, cred): Promise<PluginFetchResult>  // 归一化快照
}
```

同步流程：`/api/sync` → `sync-runner` 加载凭证 → 调插件 → 归一化写入 SQLite → 记录 `sync_log`（错误分类：`auth_expired` / `endpoint_changed` / `network` / `parse` / `not_configured`）。**没有凭证就不产数据**：同步记为 `not_configured` 失败，界面上是空态，不用模拟值填充。

**自动同步**：内置轻量调度器（`server/plugins/scheduler.server.ts`）每 60s 检查一次，按各供应商 `sync_config.interval_sec` + 抖动到期执行，日志自动裁剪（每渠道保留最近 100 条）。添加供应商时会立即触发一次后台同步。

> 注意目录约定：`server/plugins/` 是 Nitro 的插件目录（只放带 default 导出的 nitro 插件），**渠道插件框架在 `server/providers/`**，两者不要混放。

### 凭证方式（StepFun）

| 方式 | 适用 | 说明 |
|------|------|------|
| **浏览器登录（推荐）** | 完整数据（套餐/用量/余额） | 弹出真实浏览器登录一次，会话持久化在 profile；之后每次同步启动无头浏览器加载控制台页面，前端自动刷新 30 分钟短效 token，RPC 在页面上下文内执行。登录窗口用完即可关闭。Docker 部署需显示环境（Xvfb/VNC） |
| API Key | 余额/账户类型 | 官方接口 `/v1/accounts`，稳定但拿不到 Step Plan 用量 |
| 粘贴 Cookie | 临时 | Oasis-Token 仅 30 分钟寿命且绑定会话，粘贴基本必失败，仅作应急调试手段 |

### Cookie 获取引导

Cookie 类渠道内置引导流程（[components/CookieGuide.vue](components/CookieGuide.vue)，引导内容由插件的 `cookieGuide` 元数据提供）：

1. **分步图文引导**：打开登录页 → F12 开发者工具 → Network 标签 → 复制请求头里的 Cookie → 粘贴保存
2. **书签小工具**：弹窗里有个「拖我到书签栏」按钮，拖到书签栏后，在平台页面点击即可自动复制 Cookie 到剪贴板（HttpOnly Cookie 不适用时会提示改用手动步骤）
3. **保存即验证**：粘贴后点「验证并保存」，系统立即同步一次——成功则开始采集，失败则在弹窗内显示具体原因（如「Cookie 已失效，请重新获取」），可当场重试
4. **过期更新**：详情页「更新凭证」按钮随时重新走引导流程（`POST /api/providers/[id]/credential`，保存后自动同步验证）

### 已实现：StepFun（`server/providers/stepfun.ts`）

| 凭证 | 取数内容 | 状态 |
|------|---------|------|
| API Key | `GET https://api.stepfun.com/v1/accounts`（官方文档接口）：余额、账户类型、累计充值/赠送 | 已验证（真实调用，错误分类正确） |
| Cookie | 直连控制台内部 Connect-RPC（端点从前端 bundle 的 protobuf 描述逆向获得，无官方文档）：`GetStepPlanStatus`（订阅/到期/自动续费/计划价格）、`QueryStepPlanUsages`（套餐 Credits 按模型按天用量）、`DevQueryUsageHistory`（按量计费明细）、`QueryAccountBalance`（余额）、`UserInfo`（账户）；失败降级 Playwright 捕获 XHR 重新发现端点 | **关键：RPC 必须带头 `connect-protocol-version: 1` + `oasis-appid: 10300` + `oasis-platform: web`**，缺头会把合法 token 判为 "oasis-token is embezzled" 401 |

控制台 RPC 端点：`POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/{GetStepPlanStatus,DevQueryUsageHistory,QueryAccountBalance}`，请求头带登录 Cookie。金额字段单位为「分」（如套餐价 `9900` = ¥99）。

> StepFun 官方 API **不提供** Step Plan 用量/配额查询（`/step_plan/v1/accounts` 返回 404，文档索引已核对），控制台 RPC 是唯一途径。Playwright 仅作为端点变更时的兜底发现手段，需 `npm i -D playwright && npx playwright install chromium`（Docker 镜像内需一并安装）。

新增渠道：在 `server/providers/` 新建插件文件，到 `server/providers/index.ts` 登记即可。

## 当前状态（MVP）

- **9 家渠道插件已接入**：DeepSeek / BigModel 智谱 / StepFun / Xiaomi MiMo / OpenCode / Qoder / 通义 / 火山引擎 / Trae（各家凭证方式见详情页与上文「渠道插件」章节）
- **桌面悬浮球客户端 v0.1**（Tauri 2 · Windows）已实现：白瓷球、置顶分组面板、设置抽屉、贴边收纳、开机自启
- 无凭证不产数据：同步记 `not_configured`，界面呈空态，不用模拟值填充
- 后续阶段：凭证加密存储、REST Bearer 鉴权、告警通知通道
