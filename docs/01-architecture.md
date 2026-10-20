# AIUsageAtlas — 架构设计与技术选型（草案 v0.1）

> 状态：待评审 · 2026-10-20
> 定位：自托管的「AI 供应商额度/用量聚合器」。服务端单容器负责采集、存储、Web 管理；Win/Mac 托盘客户端只读展示并触发刷新。单用户、访问令牌鉴权，不做账户体系。

## 1. 总体架构

```
┌─ Server 容器（单 Docker 镜像）────────────────────────────┐
│ Nuxt3 (前后端一体, Nitro runtime)                          │
│ ├─ /web       管理页：供应商增删改、用量看板、同步日志        │
│ ├─ /api       REST + WebSocket（推送同步进度）              │
│ ├─ Scheduler  每供应商独立 interval + 手动刷新队列           │
│ ├─ Plugin Host  渠道插件加载 / 执行 / 超时与错误隔离         │
│ ├─ PriceSource  LiteLLM 定价 JSON 每日快照 + 渠道自带价格表  │
│ └─ SQLite (better-sqlite3, WAL)  凭证字段加密存储           │
│                                                            │
│ Playwright（登录捕获 / 控制台爬取，独立于请求直取路径）        │
└──────────────┬─────────────────────────────────────────────┘
               │ REST + Bearer Token（服务器地址 + 令牌）
┌──────────────▼──────────────┐
│ Tauri2 托盘客户端 (Win & Mac) │  额度条 / 重置倒计时 / 续费日 / 余额
│ 只读展示 + 手动刷新按钮        │  POST /api/sync 触发一次采集
└─────────────────────────────┘
```

数据流：**Scheduler/手动触发 → Plugin Host 调渠道插件 → 归一化快照 → SQLite → /api → Web 看板 & 托盘客户端**。

## 2. 核心设计

### 2.1 插件接口（每个渠道一个插件）

认证方式声明在插件内部，同一插件可实现多种方式，运行时按可用性择优（API Key 直连 > Cookie 请求 > 内嵌浏览器登录捕获）：

```ts
interface ProviderPlugin {
  id: string                          // 'deepseek' | 'bigmodel' | 'stepfun' | 'xiaomimo' | 'opencode'
  displayName: string
  authMethods: AuthKind[]             // 'apikey' | 'cookie' | 'browser-login'
  login?(ctx: LoginCtx): Promise<Credential>
  // browser-login: 打开内嵌 Playwright 引导用户登录，持久化 storageState 供后续复用
  fetch(ctx: FetchCtx, cred: Credential): Promise<NormalizedSnapshot>
  scheduleDefault: string             // interval（可被用户逐供应商覆盖）
  priceTable?: LocalPrice[]           // 可选：LiteLLM 表缺失的国内模型自带价格
}
```

新增渠道 = 新增一个 `plugins/<id>/` 目录，不改核心。

### 2.2 归一化数据模型（能拿多细拿多细）

**账户维度**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `provider` | id, display_name, homepage, icon, category(subscription/api/aggregate), notes | 供应商注册信息（插件声明+用户可改） |
| `account_profile` | provider_id, user_name, email/phone(脱敏), avatar, external_user_id, region, verified_status, joined_at | 用户基本信息：插件采集账户中心可见内容，全部可空 |
| `subscription` | provider_id, plan_name, plan_id, billing_mode(subscription/api/hybrid), price, currency, renewal_date, auto_renew, payment_method(脱敏), starts_at, expires_at | 订阅计划本体；同一账户可能多计划并存（如 Coding Plan + API） |

**额度维度**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `quota_window` | provider_id, **plan_name**, name(5h/周/月), used_pct, used_value, limit_value, unit(token/dollar/hours/messages), reset_at, extra_usage_enabled | 配额窗口必须挂计划名——多计划各有窗口，展示与历史对比都按 (plan, window) 聚合 |

**用量维度**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `usage_daily` | provider_id, **plan_name**, date, input/output/cached_tokens, requests, cost_amount, cost_currency, source(api/scrape/estimated) | 日粒度汇总；source 标记数据精度来源 |
| `usage_model_daily` | provider_id, date, model_id, input/output/cached/thinking_tokens, requests, errors | 按模型拆分（API/聚合平台可拿到；订阅类缺省） |
| `balance_snapshot` | provider_id, date, balance, currency, recharged_amount | 每日余额快照——API 平台余额即钱，支撑充值/耗尽预测 |

**价格维度**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `model_price` | provider_id, model_id, source(litellm/plugin/manual), currency, input_per_m, output_per_m, cached_read_per_m, cached_write_per_m, batch_price, context_window, effective_from, fetched_at | API 模型价格表，effective_from 版本化，现价=最新一条 |
| `price_change_log` | model_id, field, old_value, new_value, changed_at | 价格变动追踪：订阅"性价比"分析 + 官方调价第一时间发现 |

**运行维度**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `credential` | provider_id, kind(apikey/cookie/storage_state/oauth), payload(加密), expires_at, updated_at | 统一存 SQLite，机器绑定密钥加密 |
| `sync_config` | provider_id, enabled, interval_sec, jitter_sec, timeout_sec | 每渠道独立同步间隔 |
| `sync_log` | provider_id, started_at, status, duration_ms, error_type(auth_expired/endpoint_changed/network/parse), error_msg | error_type 分类驱动告警和插件健康度 |
| `plugin_meta` | plugin_id, version, endpoints_fingerprint, last_run_at, health | 端点指纹变化 = 官网改版第一时间察觉 |
| `alert_rule` | provider_id, metric(used_pct/balance/low/days_to_renewal/sync_fail), threshold, channels | 额度阈值/余额不足/续费临近/登录失效告警 |
| `api_token` | name, token_hash, created_at, last_used_at | 客户端访问令牌管理 |
| `settings` | display_currency, fx_rate, timezone, week_start | 全局偏好：多币种折算、时区（各家重置时间是当地时区！） |

设计原则：
1. 不同供应商数据精度不齐是常态，**所有表允许部分为空**，UI 按可得字段渲染。
2. `plan_name` 贯穿额度/用量表——一个供应商 = 一个账户，但账户下可挂多个计划（订阅+API 混合很常见），聚合键统一为 `(provider_id, plan_name)`。
3. 时间字段一律存 UTC + 记录来源时区，重置倒计时按供应商当地时区语义展示。

### 2.3 调度与刷新

- 每供应商独立 interval + 随机抖动（防风控节奏特征）
- 手动刷新进入同一队列，同一供应商任务去重；WebSocket 推送进度
- 采集优先级：能用 HTTP 直取接口绝不开浏览器

## 3. MVP 渠道策略

| 渠道 | 首选取数 | 说明 |
|------|---------|------|
| DeepSeek | API Key 直连 | 官方余额/充值接口 |
| BigModel（智谱） | API Key 直连 + 控制台爬取 | 余额可直连；用量明细走爬取 |
| StepFun | Cookie / 登录捕获 | 无公开用量 API，MVP 期实测控制台端点 |
| XiaomiMimo | Cookie / 登录捕获 | 同上 |
| OpenCode | API Key（Zen 按量）/ Cookie | 两种形态都可能出现，插件内分支 |

价格换算：LiteLLM 定价 JSON 每日刷新缓存；国内模型缺失项由渠道插件自带价格表兜底。

## 4. 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 语言 | TypeScript 全栈 | 前后端+插件一门语言；爬虫生态最成熟 |
| Web 框架 | Nuxt3 + Nitro | server routes 天然"前端+后端+API"同进程单镜像 |
| 数据库 | better-sqlite3 + WAL | 零外部依赖单文件，卷挂载即持久化 |
| 采集 | Playwright + undici | Playwright 管登录捕获/页面爬取；undici 管接口直取 |
| 调度 | 内置轻量 scheduler | 按供应商多实例 + 抖动，不引重型任务框架 |
| 插件加载 | 目录约定 `plugins/<id>/index.ts`，构建期打包 + 运行期动态 import | V1 不做插件市场，先内置 |
| 桌面端 | Tauri2 | Win/Mac 托盘壳 <10MB，Rust 只做托盘/通知，不碰爬虫 |
| 鉴权 | 服务端生成访问令牌，客户端只存令牌 | 单用户够用 |
| 部署 | 单镜像 docker-compose，`/data` 卷存 sqlite + 浏览器 profile + 加密凭证 | |

## 5. V1 明确不做

多用户/权限体系、本地日志采集流派（定位差异：本项目做"官方在线数据"，与 AIUsage/ccusage 的本地日志路线互补）、自动账单核对、移动端、第三方插件市场。

## 6. 主要风险

1. **爬取端点稳定性**：订阅控制台接口未公开，随改版失效需插件热修复 → 插件独立版本字段 + sync_log 告警缓解。
2. **登录态风控**：Cookie/浏览器 profile 长期使用可能触发二次验证 → 设计"重新登录"流程为一等公民。
3. **凭证安全**：storageState/cookie 即账户本体，必须加密落盘，令牌泄露等于全部账户泄露 → Web 端仅局域网/内网部署为前提。
