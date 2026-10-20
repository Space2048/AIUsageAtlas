<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    icon?: string
    seed: string
    text: string
    name: string
    size?: number
  }>(),
  { icon: '', size: 42 }
)

const PALETTE: Array<[string, string]> = [
  ['#ffe9df', '#f4643c'],
  ['#e0f3e9', '#2f9e6e'],
  ['#efe9ff', '#8b6bf0'],
  ['#e8efff', '#4a7dff'],
  ['#fdf0dc', '#e0952a'],
  ['#fde8e6', '#e8594f'],
]

const broken = ref(false)
const showImg = computed(() => !!props.icon && !broken.value)

const matStyle = computed(() => {
  let h = 0
  for (const c of props.seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const [bg, fg] = PALETTE[h % PALETTE.length]
  return {
    background: bg,
    color: fg,
    width: `${props.size}px`,
    height: `${props.size}px`,
    borderRadius: `${Math.round(props.size * 0.31)}px`,
    fontSize: `${Math.round(props.size * 0.33)}px`,
  }
})

watch(() => props.icon, () => (broken.value = false))
</script>

<template>
  <div class="pc-avatar" :class="{ 'pc-avatar--logo': showImg }" :style="matStyle">
    <img v-if="showImg" :src="icon" :alt="name" @error="broken = true" />
    <template v-else>{{ text }}</template>
  </div>
</template>
