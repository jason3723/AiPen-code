<script setup lang="ts">
/**
 * 批注列表 · CandidatePanel 式抽屉（右侧，内联，挤占编辑器空间）
 *  - 收起时：root width=0，28px 触发标签 translateX(-57%) 只露出 ~12px（仿候选库图标）
 *  - 展开时：root width=280px，触发标签归位 + 面板露出，挤压编辑器
 *  - 面板裁剪由独立 clip 容器完成（overflow:hidden），root 自身不裁剪
 *  - 不再 Teleport：作为 RichEditor flex 子节点内联渲染
 */
import { ref, computed, watch, nextTick } from 'vue'
import { useDocumentStore } from '../stores/document'
import { useConfirm } from '../composables/useConfirm'
import type { Comment } from '../types/comment'

const store = useDocumentStore()
const { confirm } = useConfirm()

const emit = defineEmits<{
  jump: [commentId: string]
}>()

const open = ref(false)

// 双向同步 store.editingCommentId
const editingId = ref<string>('')
watch(() => store.editingCommentId, (id) => {
  editingId.value = id
  if (id) {
    const c = sortedComments.value.find(c => c.id === id)
    if (c) editText.value = c.text
    if (!open.value) open.value = true
  }
})
const editText = ref<string>('')

const sortedComments = computed(() => {
  return [...store.comments].sort((a, b) => a.order - b.order)
})

const liveCount = computed(() => sortedComments.value.filter(c => !c.orphan).length)
const orphanCount = computed(() => sortedComments.value.length - liveCount.value)
const hasAny = computed(() => sortedComments.value.length > 0)

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
  cancelEdit()
}

function startEdit(c: Comment) {
  editingId.value = c.id
  editText.value = c.text
  store.editingCommentId = c.id
}

function confirmEdit() {
  if (editingId.value && editText.value.trim()) {
    store.updateCommentText(editingId.value, editText.value)
  }
  cancelEdit()
}

function cancelEdit() {
  editingId.value = ''
  editText.value = ''
  store.editingCommentId = ''
}

async function del(c: Comment) {
  const ok = await confirm({
    title: '删除批注',
    message: `确定要删除 [${c.order}] 的批注吗？此操作可通过 Ctrl+Z 撤销。\n\n${c.text}`,
    kind: 'warning',
    okLabel: '删除',
    cancelLabel: '取消',
  })
  if (!ok) return
  store.deleteComment(c.id)
}

function jumpTo(c: Comment) {
  if (c.orphan) return
  emit('jump', c.id)
}

async function clearAll() {
  const ok = await confirm({
    title: '清除所有批注',
    message: `确定要清除全部 ${liveCount.value} 条批注吗？此操作不可撤销。`,
    kind: 'danger',
    okLabel: '全部清除',
    cancelLabel: '取消',
  })
  if (!ok) return
  // 从后往前删，避免索引偏移
  const ids = [...store.comments].map(c => c.id).reverse()
  for (const id of ids) {
    store.deleteComment(id)
  }
  open.value = false
}

// 编辑时滚动到当前条目
watch(editingId, (id) => {
  if (!id) return
  nextTick(() => {
    const el = document.querySelector('.comment-list-item.is-editing') as HTMLElement | null
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
})

defineExpose({ open })
</script>

<template>
  <div v-if="hasAny" class="comment-root" :class="{ 'is-open': open }">
    <!-- Clip 容器：仅用于裁剪面板，root 自身不 overflow:hidden -->
    <div class="comment-clip">
      <div class="comment-panel">
        <!-- 头部 -->
        <div class="comment-panel-head">
          <span class="comment-panel-title">📝 批注 ({{ liveCount }})</span>
          <span v-if="orphanCount > 0" class="comment-panel-orphan">含 {{ orphanCount }} 条孤儿</span>
          <span class="flex-1" />
          <button class="comment-panel-close" title="关闭" @click="close">✕</button>
        </div>

        <!-- 列表 -->
        <ol class="comment-list-items">
          <li
            v-for="c in sortedComments"
            :key="c.id"
            class="comment-list-item"
            :class="{
              'is-orphan': c.orphan,
              'is-editing': editingId === c.id,
            }"
          >
            <div class="comment-list-top">
              <span class="comment-list-order">[{{ c.order }}]</span>
              <div class="comment-list-body">
                <textarea
                  v-if="editingId === c.id"
                  v-model="editText"
                  :maxlength="500"
                  rows="5"
                  class="comment-list-editarea"
                  @keyup.esc="cancelEdit"
                  @keyup.ctrl.enter="confirmEdit"
                  @keyup.meta.enter="confirmEdit"
                />
                <p v-else class="comment-list-text">{{ c.text }}</p>
              </div>
            </div>
            <div class="comment-list-bottom">
              <div class="comment-list-meta">
                <span>{{ formatDate(c.createdAt) }}</span>
                <span v-if="c.orphan" class="comment-list-orphan-tag">⚠ 原文已删除</span>
              </div>
              <div class="comment-list-actions">
                <template v-if="editingId === c.id">
                  <button class="comment-list-btn comment-list-btn-confirm" @click="confirmEdit" :disabled="!editText.trim()">✓ 确认</button>
                  <button class="comment-list-btn" @click="cancelEdit">✕ 取消</button>
                </template>
                <template v-else>
                  <button
                    class="comment-list-btn"
                    :disabled="c.orphan"
                    :title="c.orphan ? '原文已删除' : '跳转到批注文字'"
                    @click="jumpTo(c)"
                  >📍 跳转</button>
                  <button class="comment-list-btn" title="编辑" @click="startEdit(c)">✎ 编辑</button>
                  <button class="comment-list-btn comment-list-btn-danger" title="删除" @click="del(c)">🗑 删除</button>
                </template>
              </div>
            </div>
          </li>
        </ol>

        <!-- 底部：清除所有批注 -->
        <div class="comment-panel-foot">
          <button class="comment-clear-btn" @click="clearAll">🗑 清除所有批注</button>
        </div>
      </div>
    </div>

    <!-- 触发标签：面板打开时隐藏，折叠时显示 -->
    <button
      v-show="!open"
      class="comment-trigger"
      :title="`展开批注列表（${liveCount}）`"
      @click="toggle"
    >
      <svg class="comment-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h10M7 16h4" />
      </svg>
      <span class="comment-trigger-badge">{{ liveCount }}</span>
    </button>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════
   Root：flex 子节点，收起时 width=0（不占编辑器空间）
   自身不设 overflow:hidden，让触发标签可以向左突出
   ═══════════════════════════════════════════════ */
.comment-root {
  position: relative;
  flex-shrink: 0;
  width: 0;
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  background: transparent;
}
.comment-root.is-open {
  width: 280px;
  border-left: 1px solid #e5e7eb;
  background: #ffffff;
}

/* ═══════════════════════════════════════════════
   Clip 容器：裁剪面板区域
   父级 flex body 的 overflow:hidden 会在 root=0 时把超出部分裁掉
   ═══════════════════════════════════════════════ */
.comment-clip {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  overflow: hidden;
}

/* ═══════════════════════════════════════════════
   面板：280px，常驻在 clip 内
   ═══════════════════════════════════════════════ */
.comment-panel {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  display: flex;
  flex-direction: column;
}

/* 头部 */
.comment-panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid #e5e7eb;
  background: rgba(254, 243, 199, 0.25);
  flex-shrink: 0;
}
.comment-panel-title {
  font-weight: 600;
  font-size: 12px;
  color: #374151;
}
.comment-panel-orphan {
  font-size: 10px;
  color: #b45309;
}
.comment-panel-close {
  background: transparent;
  border: none;
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
  transition: background-color 0.12s;
  line-height: 1;
}
.comment-panel-close:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #1f2937;
}

/* ═══════════════════════════════════════════════
   触发标签：root 的直接子节点
   收起时 translateX(-57%) 向左突出，只有 ~12px 露出
   展开时 translateX(0) 完整显示
   ═══════════════════════════════════════════════ */
.comment-trigger {
  position: absolute;
  left: 0;
  top: 20px;
  width: 28px;
  height: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  opacity: 0.45;
  background: rgba(203, 213, 225, 0.25);
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-right: none;
  border-radius: 6px 0 0 6px;
  cursor: pointer;
  transform: translateX(-57%);
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.2s ease;
  z-index: 1;
}
.comment-trigger:hover {
  opacity: 0.95;
  transform: translateX(-85%);
}
.comment-root.is-open .comment-trigger {
  transform: translateX(0);
  opacity: 0.85;
}
.comment-root.is-open .comment-trigger:hover {
  opacity: 1;
  transform: translateX(0);
}

.comment-trigger-icon {
  width: 16px;
  height: 16px;
  color: #6b7280;
}

.comment-trigger-badge {
  position: absolute;
  top: -4px;
  left: -4px;
  min-width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: #d97706;
  border-radius: 999px;
}

/* ═══════════════════════════════════════════════
   列表
   ═══════════════════════════════════════════════ */
.comment-list-items {
  list-style: none;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  flex: 1;
}
.comment-list-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 10px;
  font-size: 12px;
  background: transparent;
  border-bottom: 1px solid #f3f4f6;
  transition: background-color 0.12s;
}
.comment-list-item:hover {
  background: #f9fafb;
}
.comment-list-item.is-orphan {
  opacity: 0.5;
}
.comment-list-item.is-editing {
  background: #fffbeb;
}

/* 上半行：序号 + 文字 */
.comment-list-top {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.comment-list-order {
  color: #b45309;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-weight: 600;
  flex-shrink: 0;
  min-width: 26px;
}
.comment-list-body {
  flex: 1;
  min-width: 0;
}
.comment-list-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: #1f2937;
  font-size: 12px;
  line-height: 1.45;
}
.comment-list-editarea {
  width: 100%;
  font-size: 11px;
  line-height: 1.45;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  padding: 3px 5px;
  background: #fff;
  color: inherit;
  font-family: inherit;
  resize: vertical;
}

/* 下半行：元信息 + 操作按钮 */
.comment-list-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
}
.comment-list-meta {
  flex: 1;
  min-width: 0;
  font-size: 9px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 3px;
}
.comment-list-orphan-tag {
  color: #dc2626;
  font-weight: 500;
}

/* 操作按钮 */
.comment-list-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.comment-list-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 2px 5px;
  cursor: pointer;
  font-size: 10px;
  color: #6b7280;
  white-space: nowrap;
  transition: all 0.12s;
}
.comment-list-btn:hover:not(:disabled) {
  background: #e5e7eb;
  color: #1f2937;
}
.comment-list-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.comment-list-btn-danger:hover {
  background: #fee2e2 !important;
  color: #dc2626 !important;
}
.comment-list-btn-confirm {
  background: #2563eb !important;
  color: #fff !important;
}
.comment-list-btn-confirm:hover:not(:disabled) {
  background: #1d4ed8 !important;
  color: #fff !important;
}

/* 底部清除按钮 */
.comment-panel-foot {
  flex-shrink: 0;
  padding: 6px 10px;
  border-top: 1px solid #e5e7eb;
}
.comment-clear-btn {
  display: block;
  width: 100%;
  padding: 4px 0;
  font-size: 11px;
  color: #dc2626;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.12s;
}
.comment-clear-btn:hover {
  background: #fee2e2;
}
</style>

<style>
.dark .comment-root.is-open {
  border-left-color: #334155;
  background: #1e2030;
}
.dark .comment-panel-head {
  border-bottom-color: #334155;
  background: rgba(120, 53, 15, 0.1);
}
.dark .comment-panel-title {
  color: #e5e7eb;
}
.dark .comment-panel-orphan {
  color: #fbbf24;
}
.dark .comment-panel-close {
  color: #94a3b8;
}
.dark .comment-panel-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #e5e7eb;
}
.dark .comment-trigger {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.08);
}
.dark .comment-trigger-icon {
  color: #94a3b8;
}
.dark .comment-list-item {
  border-bottom-color: #1e293b;
}
.dark .comment-list-item:hover {
  background: rgba(255, 255, 255, 0.03);
}
.dark .comment-list-item.is-editing {
  background: rgba(251, 191, 36, 0.06);
}
.dark .comment-list-order {
  color: #fbbf24;
}
.dark .comment-list-text {
  color: #e5e7eb;
}
.dark .comment-list-editarea {
  background: #0f172a;
  border-color: #475569;
  color: #e5e7eb;
}
.dark .comment-list-meta {
  color: #94a3b8;
}
.dark .comment-list-btn {
  color: #94a3b8;
}
.dark .comment-list-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}
.dark .comment-list-btn-danger:hover {
  background: rgba(220, 38, 38, 0.15) !important;
  color: #fca5a5 !important;
}
.dark .comment-panel-foot {
  border-top-color: #334155;
}
.dark .comment-clear-btn:hover {
  background: rgba(220, 38, 38, 0.15);
}
</style>
