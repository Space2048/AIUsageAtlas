<template>
  <header class="topbar">
    <NuxtLink to="/" class="brand">
      <img class="brand-mark" src="/icon.svg" alt="" width="36" height="36">
      <div>
        <div class="brand-title">AIUsageAtlas</div>
        <div class="brand-sub">AI 供应商额度与用量聚合</div>
      </div>
    </NuxtLink>
    <nav class="nav">
      <NuxtLink to="/" class="nav-link" active-class="active">仪表盘</NuxtLink>
      <NuxtLink to="/prices" class="nav-link" active-class="active">价格表</NuxtLink>
      <NuxtLink to="/settings" class="nav-link" active-class="active">设置</NuxtLink>
    </nav>
    <div class="topbar-actions">
      <slot />
    </div>
  </header>
</template>
