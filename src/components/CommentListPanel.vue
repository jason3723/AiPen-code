<script setup lang="ts">
/**
 * 统一抽屉面板 ── 批注 + 比对双 tab
 *  - 折叠时：trigger 按钮垂直排列（各有内容才显示）
 *  - 展开时：tab 栏切换（双 tab 都出现时显示栏，单 tab 仅标题）
 *  - 面板状态由 compareStore 统一管理
 *  - 批注内容保持不变，比对内容由 <CompareView /> 渲染
 */
import { ref, computed, watch, nextTick } from 'vue'
import { useDocumentStore } from '../stores/document'
import { useCompareStore } from '../stores/compareStore'
import { useConfirm } from '../composables/useConfirm'
import type { Comment } from '../types/comment'
import CompareView from './CompareView.vue'

const store = useDocumentStore()
const compareStore = useCompareStore()
const { confirm } = useConfirm()

const emit = defineEmits<{
  jump: [commentId: string]
}>()

// ── 面板状态（从 compareStore 读取） ──

const panelOpen = computed(() => compareStore.panelOpen)
const activeTab = computed(() => compareStore.activeTab)

function switchTab(tab: 'comment' | 'compare') {
  compareStore.activeTab = tab
}

// ── 批注数据 ──

const editingId = ref<string>('')
watch(() => store.editingCommentId, (id) => {
  editingId.value = id
  if (id) {
    const c = sortedComments.value.find(c => c.id === id)
    if (c) editText.value = c.text
    compareStore.openTab('comment')
  }
})
const editText = ref<string>('')

const sortedComments = computed(() => {
  return [...store.comments].sort((a, b) => a.order - b.order)
})

const liveCount = computed(() => sortedComments.value.filter(c => !c.orphan).length)
const orphanCount = computed(() => sortedComments.value.length - liveCount.value)
const hasComments = computed(() => sortedComments.value.length > 0)
const hasCompare = computed(() => compareStore.hasEntries)
const hasAny = computed(() => hasComments.value || hasCompare.value)

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function close() {
  compareStore.closePanel()
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
  const ids = [...store.comments].map(c => c.id).reverse()
  for (const id of ids) {
    store.deleteComment(id)
  }
}

// 编辑时滚动到当前条目
watch(editingId, (id) => {
  if (!id) return
  nextTick(() => {
    const el = document.querySelector('.comment-list-item.is-editing') as HTMLElement | null
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
})

defineExpose({ open: panelOpen })
</script>

<template>
  <div v-if="hasAny" class="comment-root" :class="{ 'is-open': panelOpen }">
    <!-- Clip 容器：裁剪面板区域 -->
    <div class="comment-clip">
      <div class="comment-panel">
        <!-- ── 头部：tab 栏或单标题 ── -->
        <div class="comment-panel-head" :class="{ 'has-tabs': hasComments && hasCompare }">
          <!-- 双 tab 栏 -->
          <template v-if="hasComments && hasCompare">
            <button
              class="panel-tab"
              :class="{ active: activeTab === 'comment' }"
              @click="switchTab('comment')"
            >
              📝 批注 ({{ liveCount }})
            </button>
            <button
              class="panel-tab"
              :class="{ active: activeTab === 'compare' }"
              @click="switchTab('compare')"
            >
              🔍 比对 ({{ compareStore.entryCount }})
            </button>
            <span class="flex-1" />
            <button class="comment-panel-close" title="关闭" @click="close">✕</button>
          </template>
          <!-- 仅有批注：保持原标题风格 -->
          <template v-else-if="hasComments">
            <span class="comment-panel-title">📝 批注 ({{ liveCount }})</span>
            <span v-if="orphanCount > 0" class="comment-panel-orphan">含 {{ orphanCount }} 条孤儿</span>
            <span class="flex-1" />
            <button class="comment-panel-close" title="关闭" @click="close">✕</button>
          </template>
          <!-- 仅有比对 -->
          <template v-else>
            <span class="comment-panel-title">🔍 比对 ({{ compareStore.entryCount }})</span>
            <span class="flex-1" />
            <button class="comment-panel-close" title="关闭" @click="close">✕</button>
          </template>
        </div>

        <!-- ── 批注内容 ── -->
        <template v-if="hasComments">
          <ol v-show="activeTab === 'comment'" class="comment-list-items">
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

          <!-- 批注底部 -->
          <div v-show="activeTab === 'comment'" class="comment-panel-foot">
            <button class="comment-clear-btn" @click="clearAll">🗑 清除所有批注</button>
          </div>
        </template>

        <!-- ── 比对内容 ── -->
        <template v-if="hasCompare">
          <div v-show="activeTab === 'compare'" class="compare-panel-body">
            <CompareView />
          </div>
        </template>
      </div>
    </div>

    <!-- ── 触发标签（面板关闭时显示） ── -->
    <template v-if="!panelOpen">
      <!-- 批注 trigger：有批注才显示 -->
      <button
        v-if="hasComments"
        class="panel-trigger"
        :title="`展开批注列表（${liveCount}）`"
        @click="compareStore.openTab('comment')"
      >
        <svg class="panel-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h10M7 16h4" />
        </svg>
        <span class="panel-trigger-badge _comment">{{ liveCount }}</span>
      </button>

      <!-- 比对 trigger：有比对条目才显示 -->
      <button
        v-if="hasCompare"
        class="panel-trigger"
        :class="{ '_second': hasComments }"
        :title="`展开比对（${compareStore.entryCount}）`"
        @click="compareStore.openTab('compare')"
      >
        <svg class="panel-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="8" height="16" rx="1" />
          <rect x="14" y="4" width="8" height="16" rx="1" />
          <path d="M10 12h4" />
        </svg>
        <span class="panel-trigger-badge _compare">{{ compareStore.entryCount }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════
   Root：flex 子节点
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
   Clip 容器
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
   面板本体
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

/* ── 头部 ── */
.comment-panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid #e5e7eb;
  background: rgba(254, 243, 199, 0.25);
  flex-shrink: 0;
}
.comment-panel-head.has-tabs {
  padding: 0;
  gap: 0;
  background: rgba(249, 250, 251, 1);
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
  padding: 2px 8px;
  border-radius: 3px;
  transition: all 0.12s;
  line-height: 1;
  flex-shrink: 0;
}
.comment-panel-close:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #1f2937;
}

/* ── Tab 栏按钮 ── */
.panel-tab {
  flex: 1;
  padding: 9px 6px;
  font-size: 12px;
  font-weight: 500;
  color: #9ca3af;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
  white-space: nowrap;
}
.panel-tab:hover {
  color: #6b7280;
  background: rgba(0, 0, 0, 0.02);
}
.panel-tab.active {
  color: #1f2937;
  font-weight: 600;
  border-bottom-color: #2563eb;
  background: rgba(37, 99, 235, 0.04);
}

/* ═══════════════════════════════════════════════
   触发标签（共用的 base，通过 class 覆盖 position）
   ═══════════════════════════════════════════════ */
.panel-trigger {
  position: absolute;
  left: 0;
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
  /* 默认位置（第一个，无兄弟） */
  top: 20px;
}
/* 第二个 trigger（下方） */
.panel-trigger._second {
  top: 76px;  /* 20 + 48 + 8 */
}

.panel-trigger:hover {
  opacity: 0.95;
  transform: translateX(-85%);
}
.comment-root.is-open .panel-trigger {
  transform: translateX(0);
  opacity: 0.85;
}
.comment-root.is-open .panel-trigger:hover {
  opacity: 1;
  transform: translateX(0);
}

.panel-trigger-icon {
  width: 16px;
  height: 16px;
  color: #6b7280;
}

.panel-trigger-badge {
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
  border-radius: 999px;
}
.panel-trigger-badge._comment {
  background: #d97706;
}
.panel-trigger-badge._compare {
  background: #2563eb;
}

/* ═══════════════════════════════════════════════
   比对区域（撑满面板剩余高度）
   ═══════════════════════════════════════════════ */
.compare-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ═══════════════════════════════════════════════
   列表（不变）
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
  text-align: justify;
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

.comment-panel-foot {
  flex-shrink: 0;
  padding: 6px 10px;
  border-top: 1px solid #e5e7eb;
}
.comment-clear-btn {
  display: block;
  width: 100%;
  height: 28px;
  padding: 0;
  font-size: 11px;
  font-weight: 500;
  color: #dc2626;
  background: transparent;
  border: 1px solid rgba(220, 38, 38, 0.2);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.comment-clear-btn:hover {
  background: rgba(220, 38, 38, 0.06);
  border-color: rgba(220, 38, 38, 0.4);
}
</style>

<style>
/* ═══════════════════════════════════════════════
   暗色模式（全局，不用 scoped）
   ═══════════════════════════════════════════════ */
.dark .comment-root.is-open {
  border-left-color: #334155;
  background: #1e2030;
}

.dark .comment-panel-head {
  border-bottom-color: #334155;
  background: rgba(120, 53, 15, 0.1);
}
.dark .comment-panel-head.has-tabs {
  background: #1a1d2e;
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

.dark .panel-tab {
  color: #64748b;
}
.dark .panel-tab:hover {
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.03);
}
.dark .panel-tab.active {
  color: #e5e7eb;
  border-bottom-color: #3b82f6;
  background: rgba(37, 99, 235, 0.06);
}

.dark .panel-trigger {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.08);
}
.dark .panel-trigger-icon {
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
.dark .comment-clear-btn {
  color: #94a3b8;
  border-color: rgba(255, 255, 255, 0.08);
}
.dark .comment-clear-btn:hover {
  color: #fca5a5;
  background: rgba(252, 165, 165, 0.08);
  border-color: rgba(252, 165, 165, 0.3);
}

.dark .compare-panel-body {
  /* 暗色背景继承 panel */
}
</style>
