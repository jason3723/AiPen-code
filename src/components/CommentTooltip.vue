<script setup lang="ts">
/**
 * 批注 hover 浮层
 *  - 通过 store.hoveredCommentId 控制显隐
 *  - 定位：相对目标 mark 的视口坐标，边界检测防溢出
 *  - 150ms 延迟关闭（hover 浮层本身时不立刻关）
 *  - 内容：批注文本 + 元信息 + 跳转/编辑/删除按钮
 */
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useDocumentStore } from '../stores/document'

const store = useDocumentStore()

const position = ref({ top: 0, left: 0 })
const containerRef = ref<HTMLDivElement | null>(null)
const _actualSize = ref({ w: 0, h: 0 })
let hideTimer: ReturnType<typeof setTimeout> | null = null
let lastTarget: HTMLElement | null = null

const visible = computed(() => {
  if (!store.hoveredCommentId) return false
  const c = store.comments.find(c => c.id === store.hoveredCommentId)
  if (!c) return false
  if (c.orphan) return false
  return true
})

const current = computed(() => {
  if (!store.hoveredCommentId) return null
  return store.comments.find(c => c.id === store.hoveredCommentId) || null
})

watch(visible, async (v) => {
  if (v) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    await nextTick()
    computePosition()
  }
})

/** 统一边界检测定位：优先用实测宽高，否则用预估值 */
function placeAt(target: HTMLElement) {
  const rect = target.getBoundingClientRect()
  const margin = 8
  // 用实测尺寸（渲染后）或预估（max-width 320 + 约 3 行文字 + meta + actions）
  const tipW = _actualSize.value.w || 280
  const tipH = _actualSize.value.h || 110

  // 默认：目标下方，居中对齐
  let top = rect.bottom + 6
  let left = rect.left + rect.width / 2 - tipW / 2

  // 底部溢出 → 翻到上方
  if (top + tipH + margin > window.innerHeight) {
    top = rect.top - tipH - 6
  }
  // 顶部溢出（翻到上方后仍超出） → 贴顶
  if (top < margin) top = margin

  // 左右边界
  if (left < margin) left = margin
  if (left + tipW + margin > window.innerWidth) left = window.innerWidth - tipW - margin

  position.value = { top, left }
}

/** 由 RichEditor 调用：设置 hovered id 与锚点元素 */
function show(commentId: string, target: HTMLElement | null) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  store.hoveredCommentId = commentId
  lastTarget = target
  if (target) {
    // 即刻做边界检测（用预估尺寸），避免首帧闪现
    placeAt(target)
  }
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    store.hoveredCommentId = ''
    lastTarget = null
  }, 150)
}

function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

function computePosition() {
  if (!lastTarget) return
  const tip = containerRef.value
  if (tip) {
    _actualSize.value = { w: tip.offsetWidth, h: tip.offsetHeight }
  }
  placeAt(lastTarget)
}

function onJump() {
  if (!current.value) return
  const c = current.value
  store.hoveredCommentId = ''
  // 触发父组件 jump（在 RichEditor 中已挂 CommentListPanel 的 jump 事件）
  // 通过自定义事件桥接
  const evt = new CustomEvent('comment-jump', { detail: { commentId: c.id } })
  window.dispatchEvent(evt)
}

async function onDelete() {
  if (!current.value) return
  const c = current.value
  // 简易 confirm（hover 浮层里用 window.confirm，足够轻）
  if (!window.confirm(`确定删除批注 [${c.order}] 吗？\n\n${c.text}`)) return
  store.deleteComment(c.id)
  store.hoveredCommentId = ''
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

defineExpose({ show, scheduleHide, cancelHide })

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && current"
      ref="containerRef"
      class="comment-tooltip"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      @mouseenter="cancelHide"
      @mouseleave="scheduleHide"
    >
      <div class="comment-tooltip-text">{{ current.text }}</div>
      <div class="comment-tooltip-foot">
        <span class="comment-tooltip-date">{{ formatDate(current.createdAt) }}</span>
        <button class="comment-tooltip-btn" title="跳转到原文" @click="onJump">📍</button>
        <button class="comment-tooltip-btn comment-tooltip-btn-danger" title="删除" @click="onDelete">🗑</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.comment-tooltip {
  position: fixed;
  z-index: 9998;
  max-width: 320px;
  min-width: 180px;
  padding: 8px 10px;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.5;
  color: #1f2937;
  pointer-events: auto;
}
.comment-tooltip-text {
  white-space: pre-wrap;
  word-break: break-word;
}
.comment-tooltip-foot {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.comment-tooltip-date {
  flex: 1;
  font-size: 10px;
  color: #6b7280;
}
.comment-tooltip-btn {
  background: transparent;
  border: none;
  padding: 1px 4px;
  font-size: 12px;
  line-height: 1;
  color: #9ca3af;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.12s;
}
.comment-tooltip-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #4b5563;
}
.comment-tooltip-btn-danger:hover {
  background: #fee2e2;
  color: #dc2626 !important;
}
</style>

<style>
.dark .comment-tooltip {
  background: #1e293b;
  border-color: #334155;
  color: #e5e7eb;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.dark .comment-tooltip-date {
  color: #94a3b8;
}
.dark .comment-tooltip-btn {
  color: #64748b;
}
.dark .comment-tooltip-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
}
.dark .comment-tooltip-btn-danger:hover {
  background: rgba(220, 38, 38, 0.15);
  color: #fca5a5 !important;
}
</style>
