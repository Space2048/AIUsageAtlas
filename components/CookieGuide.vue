<script setup lang="ts">
import type { CookieGuide } from '~~/shared/types'

const props = defineProps<{
  guide: CookieGuide
  saving?: boolean
  result?: { ok: boolean; message: string } | null
  supportsBrowserLogin?: boolean
}>()

const emit = defineEmits<{
  submit: [cookie: string]
  browserLogin: []
  cancel: []
}>()

const mode = ref<'paste' | 'browser'>(props.supportsBrowserLogin ? 'browser' : 'paste')
const cookie = ref('')
const copied = ref(false)

// 等待登录时的已等待秒数，避免用户以为卡死
const elapsed = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.saving,
  (v) => {
    if (v) {
      elapsed.value = 0
      elapsedTimer = setInterval(() => elapsed.value++, 1000)
    } else if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }
)
onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
})

// 书签小工具：在平台页面点击即可把 document.cookie 复制到剪贴板
const bookmarkletHref = computed(() => {
  const code = `(()=>{const c=document.cookie;if(!c){alert('未读取到 Cookie（可能是 HttpOnly），请按上方手动步骤从开发者工具的 Network 面板复制');return}navigator.clipboard.writeText(c).then(()=>alert('Cookie 已复制！回到 AIUsageAtlas 粘贴即可')).catch(()=>prompt('请手动复制以下内容：',c))})()`
  return 'javascript:' + encodeURIComponent(code)
})

async function copyBookmarklet() {
  try {
    await navigator.clipboard.writeText(bookmarkletHref.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* 剪贴板不可用时让用户手动选择 */
  }
}

function submit() {
  const v = cookie.value.trim()
  if (v) emit('submit', v)
}
</script>

<template>
  <div class="cookie-guide">
    <!-- 模式切换 -->
    <div v-if="supportsBrowserLogin" class="mode-switch">
      <button class="mode-btn" :class="{ active: mode === 'browser' }" @click="mode = 'browser'">
        <span class="mode-title">浏览器登录</span>
        <span class="mode-badge">推荐</span>
      </button>
      <button class="mode-btn" :class="{ active: mode === 'paste' }" @click="mode = 'paste'">
        <span class="mode-title">粘贴 Cookie</span>
        <span class="mode-badge warn">临时</span>
      </button>
    </div>

    <!-- 模式：浏览器登录（推荐） -->
    <template v-if="mode === 'browser'">
      <div class="guide-head">
        <div class="guide-icon" style="background:var(--green-soft)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--green)"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3" stroke-linecap="round"/></svg>
        </div>
        <div>
          <div class="guide-title">浏览器一键登录</div>
          <div class="guide-sub">在真实浏览器里登录一次，会话自动保持，无需重复粘贴</div>
        </div>
      </div>

      <ul class="guide-steps">
        <li class="guide-step">
          <span class="step-num">1</span>
          <span class="step-text">点击下方按钮，服务器会弹出一个浏览器窗口（标题为 Chromium，**可能被现有窗口遮挡，请在任务栏查找**）</span>
        </li>
        <li class="guide-step">
          <span class="step-num">2</span>
          <span class="step-text">在弹出的窗口里完成登录（扫码/账号密码/验证码）</span>
        </li>
        <li class="guide-step">
          <span class="step-num">3</span>
          <span class="step-text">登录成功后窗口自动关闭，之后每次同步自动保持会话</span>
        </li>
      </ul>

      <div class="field-hint" style="margin-bottom:4px">
        本地/桌面部署直接可用；Docker 部署时登录窗口需要显示环境（如 Xvfb/VNC），或在本地登录后将 <code>data/browser-profiles/</code> 目录拷贝到服务器。
      </div>

      <button class="btn btn-primary btn-block" :disabled="saving" @click="emit('browserLogin')">
        {{ saving ? `等待登录… 已等待 ${elapsed}s（最多 3 分钟）` : '打开浏览器登录' }}
      </button>
    </template>

    <!-- 模式：粘贴 Cookie（临时） -->
    <template v-else>
      <div class="guide-head">
        <div class="guide-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z" stroke-linecap="round"/><circle cx="8.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="12" cy="7.5" r="0.5" fill="currentColor"/><circle cx="7.5" cy="14.5" r="0.5" fill="currentColor"/><circle cx="15.5" cy="12.5" r="0.5" fill="currentColor"/></svg>
        </div>
        <div>
          <div class="guide-title">如何获取登录 Cookie</div>
          <div class="guide-sub">按步骤操作，约 1 分钟；保存后系统会立即验证</div>
        </div>
      </div>

      <ol class="guide-steps">
        <li v-for="(s, i) in guide.steps" :key="i" class="guide-step">
          <span class="step-num">{{ i + 1 }}</span>
          <span class="step-text">{{ s }}</span>
          <a v-if="i === 0" :href="guide.loginUrl" target="_blank" rel="noopener" class="btn btn-primary step-btn">打开登录页</a>
        </li>
      </ol>

      <div class="guide-actions">
        <div class="bookmarklet-row">
          <a :href="bookmarkletHref" class="bookmarklet-tag" title="把这个按钮拖到浏览器书签栏">拖我到书签栏</a>
          <span class="bookmarklet-hint">放到书签栏后，在平台页面点击它可自动复制 Cookie（HttpOnly 时不完整，请用手动步骤）</span>
          <button class="btn" @click="copyBookmarklet">{{ copied ? '已复制' : '复制书签代码' }}</button>
        </div>
      </div>

      <div class="field">
        <label class="field-label">粘贴 Cookie</label>
        <textarea v-model="cookie" class="guide-textarea" rows="3" placeholder="session=xxxx; other=yyyy" spellcheck="false" />
        <div class="field-hint">支持多种格式直接粘贴：原始 name=value 串、带 Cookie: 前缀的整行、cURL 命令、DevTools 导出的 JSON——保存时会自动识别转换。</div>
      </div>
    </template>

    <div v-if="result" class="result-banner" :class="result.ok ? 'ok' : 'err'">
      <span class="result-dot" />
      <span>{{ result.message }}</span>
    </div>

    <div class="modal-actions">
      <button class="btn" @click="emit('cancel')">取消</button>
      <button v-if="mode === 'paste'" class="btn btn-primary" :disabled="!cookie.trim() || saving" @click="submit">
        {{ saving ? '验证中…' : '验证并保存' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.cookie-guide { display: flex; flex-direction: column; gap: 18px; }

.mode-switch {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  background: var(--bg-sunken);
  border-radius: 14px;
  padding: 5px;
}
.mode-btn {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 11px;
  border: none; border-radius: 10px;
  background: transparent;
  font-size: 13.5px; font-weight: 650;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}
.mode-btn:hover { color: var(--text); }
.mode-btn.active { background: #fff; color: var(--text); box-shadow: var(--shadow-sm); }
.mode-badge {
  font-size: 10px; font-weight: 700;
  background: var(--green-soft); color: var(--green);
  padding: 2px 7px; border-radius: 6px;
}
.mode-badge.warn { background: var(--amber-soft); color: var(--amber); }

.guide-head { display: flex; gap: 13px; align-items: flex-start; }
.guide-icon {
  width: 40px; height: 40px; border-radius: 12px;
  background: var(--amber-soft);
  display: grid; place-items: center;
  flex-shrink: 0;
}
.guide-icon svg { width: 20px; height: 20px; color: var(--amber); }
.guide-title { font-size: 17px; font-weight: 750; letter-spacing: -0.2px; }
.guide-sub { font-size: 12.5px; color: var(--text-dim); margin-top: 3px; }

.guide-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.guide-step {
  display: flex; align-items: center; gap: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 11px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.step-num {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--ink); color: #fff;
  display: grid; place-items: center;
  font-size: 11.5px; font-weight: 700;
  flex-shrink: 0;
}
.step-text { flex: 1; }
.step-btn { flex-shrink: 0; padding: 7px 13px; font-size: 12.5px; }

.guide-actions {
  background: var(--accent-soft);
  border: 1px solid #cfddff;
  border-radius: 12px;
  padding: 13px 15px;
}
.bookmarklet-row { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; }
.bookmarklet-tag {
  background: #fff;
  border: 1.5px solid var(--accent);
  color: var(--accent);
  font-size: 12.5px; font-weight: 700;
  padding: 7px 13px; border-radius: 9px;
  cursor: grab;
  text-decoration: none;
  box-shadow: var(--shadow-sm);
}
.bookmarklet-hint { flex: 1; min-width: 180px; font-size: 11.5px; color: var(--text-dim); line-height: 1.5; }

.btn-block { width: 100%; justify-content: center; padding: 12px; font-size: 14px; }
</style>
