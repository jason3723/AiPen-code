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
import { useProofreadStore } from '../stores/proofreadStore'
import { useConfirm } from '../composables/useConfirm'
import type { Comment } from '../types/comment'
import CompareView from './CompareView.vue'

const store = useDocumentStore()
const compareStore = useCompareStore()
const proofreadStore = useProofreadStore()
const { confirm } = useConfirm()

const props = defineProps<{
  /** 隐藏批注 section，仅保留比对/校对 */
  hideComments?: boolean;
  /** 隐藏校对 section，仅保留批注/比对 */
  hideProofread?: boolean;
}>();

const emit = defineEmits<{
  jump: [commentId: string]
  jumpProofread: [id: string]
  replaceProofread: [id: string]
}>()

// ── 面板状态（从 compareStore 读取） ──

const panelOpen = computed(() => compareStore.panelOpen)
const activeTab = computed(() => compareStore.activeTab)

function switchTab(tab: 'comment' | 'compare' | 'proofread') {
  compareStore.activeTab = tab
}

// ── 三 section 存在性 ──
const hasProofread = computed(() => (proofreadStore.hasItems || proofreadStore.loading) && !props.hideProofread)
/** 同时存在多个 section 时才显示 tab 栏，否则只显示单标题 */
const showTabs = computed(() => {
  const n = (hasComments.value ? 1 : 0) + (hasCompare.value ? 1 : 0) + (hasProofread.value ? 1 : 0)
  return n > 1
})

// ── 批注数据 ──

const editingId = ref<string>('')
watch(() => store.editingCommentId, (id) => {
  editingId.value = id
  if (id) {
    const c = sortedComments.value.find(c => c.id === id)
    if (c) editText.value = c.text
    compareStore.ensureTab('comment')
  }
})
const editText = ref<string>('')

const sortedComments = computed(() => {
  return [...store.comments].sort((a, b) => a.order - b.order)
})

const liveCount = computed(() => sortedComments.value.filter(c => !c.orphan).length)
const orphanCount = computed(() => sortedComments.value.length - liveCount.value)
const hasComments = computed(() => sortedComments.value.length > 0 && !props.hideComments)
const hasCompare = computed(() => compareStore.hasEntries)
const hasAny = computed(() => hasComments.value || hasCompare.value || hasProofread.value)

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

// ── 校对：trigger 列表（面板关闭时按存在顺序纵向排列） ──
const ICON = {
  comment: `<svg class="panel-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h10M7 16h4" /></svg>`,
  compare: `<svg class="panel-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="8" height="16" rx="1" /><rect x="14" y="4" width="8" height="16" rx="1" /><path d="M10 12h4" /></svg>`,
  proofread: `<svg class="panel-trigger-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M8.5 11.5l1.8 1.8 3.2-3.6"/></svg>`,
}
const visibleTriggers = computed(() => {
  const arr: { key: 'comment' | 'compare' | 'proofread'; title: string; badge: number; cls: string; icon: string }[] = []
  if (hasComments.value) arr.push({ key: 'comment', title: `展开批注列表（${liveCount.value}）`, badge: liveCount.value, cls: '_comment', icon: ICON.comment })
  if (hasCompare.value) arr.push({ key: 'compare', title: `展开比对（${compareStore.entryCount}）`, badge: compareStore.entryCount, cls: '_compare', icon: ICON.compare })
  if (hasProofread.value) arr.push({ key: 'proofread', title: `展开校对结果（${proofreadStore.itemCount}）`, badge: proofreadStore.itemCount, cls: '_proofread', icon: ICON.proofread })
  return arr
})
function openTrigger(key: 'comment' | 'compare' | 'proofread') {
  compareStore.openTab(key)
}

// ── 校对：交互 ──
function jumpProofread(id: string) {
  emit('jumpProofread', id)
}
function replaceProofread(id: string) {
  emit('replaceProofread', id)
}
function ignoreIssue(id: string) {
  proofreadStore.ignore(id)
}
function addAsCorrectWord(original: string) {
  proofreadStore.addCorrectWord(original)
}
const showWords = ref(false)
const newWord = ref('')
function removeCorrectWord(w: string) {
  proofreadStore.removeCorrectWord(w)
}
function addNewWord() {
  const t = newWord.value.trim()
  if (!t) return
  proofreadStore.addCorrectWord(t)
  newWord.value = ''
}

defineExpose({ open: panelOpen })
</script>

<template>
  <div v-if="hasAny" class="comment-root" :class="{ 'is-open': panelOpen }">
    <!-- Clip 容器：裁剪面板区域 -->
    <div class="comment-clip">
      <div class="comment-panel">
        <!-- ── 头部：tab 栏或单标题 ── -->
        <div class="comment-panel-head" :class="{ 'has-tabs': showTabs }">
          <!-- 多 tab 栏（批注 / 比对 / 校对 任意两个及以上） -->
          <template v-if="showTabs">
            <button
              v-if="hasComments"
              class="panel-tab"
              :class="{ active: activeTab === 'comment' }"
              @click="switchTab('comment')"
            >
              📝 批注 ({{ liveCount }})
            </button>
            <button
              v-if="hasCompare"
              class="panel-tab"
              :class="{ active: activeTab === 'compare' }"
              @click="switchTab('compare')"
            >
              🔍 比对 ({{ compareStore.entryCount }})
            </button>
            <button
              v-if="hasProofread"
              class="panel-tab"
              :class="{ active: activeTab === 'proofread' }"
              @click="switchTab('proofread')"
            >
              ✨ 校对 ({{ proofreadStore.itemCount }})
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
          <template v-else-if="hasCompare">
            <span class="comment-panel-title">🔍 比对 ({{ compareStore.entryCount }})</span>
            <span class="flex-1" />
            <button class="comment-panel-close" title="关闭" @click="close">✕</button>
          </template>
          <!-- 仅有校对 -->
          <template v-else>
            <span class="comment-panel-title">✨ 校对 ({{ proofreadStore.itemCount }})</span>
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
                    rows="15"
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

        <!-- ── 校对内容 ── -->
        <template v-if="hasProofread">
          <div v-show="activeTab === 'proofread'" class="proofread-panel-body">
            <!-- 进行中状态条：与实时结果同显 -->
            <div v-if="proofreadStore.loading" class="pf-stat pf-muted">🔄 {{ proofreadStore.progressMsg || '校对进行中…' }}</div>
            <div v-if="proofreadStore.error" class="pf-stat pf-error">{{ proofreadStore.error }}</div>

            <div v-if="proofreadStore.suppressed > 0" class="pf-stat pf-muted">
              已抑制 {{ proofreadStore.suppressed }} 条正词命中
            </div>
            <div v-if="proofreadStore.warnings.length" class="pf-stat pf-warn">
              ⚠ {{ proofreadStore.warnings.join('；') }}
            </div>

            <!-- 结果列表：加载中也会随事件实时增长 -->
            <ol v-if="proofreadStore.items.length" class="comment-list-items">
              <li
                v-for="it in proofreadStore.items"
                :key="it.id"
                class="comment-list-item"
              >
                <div class="pf-item-top">
                  <span class="pf-cat">{{ it.category }}</span>
                  <span class="pf-old">{{ it.original }}</span>
                  <span class="pf-arrow">→</span>
                  <span class="pf-new">{{ it.suggestion }}</span>
                </div>
                <div v-if="it.reason" class="pf-reason">{{ it.reason }}</div>
                <div class="comment-list-bottom">
                  <div class="comment-list-meta">位置 {{ it.from }}</div>
                  <div class="comment-list-actions">
                    <button class="comment-list-btn" @click="jumpProofread(it.id)">📍 跳转</button>
                    <button class="comment-list-btn" @click="replaceProofread(it.id)">✎ 替换</button>
                    <button class="comment-list-btn" @click="addAsCorrectWord(it.original)" title="标记为正确，抑制此类误报">✓ 正词</button>
                    <button class="comment-list-btn comment-list-btn-danger" @click="ignoreIssue(it.id)">忽略</button>
                  </div>
                </div>
              </li>
            </ol>
            <div
              v-else-if="!proofreadStore.loading && !proofreadStore.error && proofreadStore.cleanHint"
              class="pf-stat pf-muted"
            >
              未发现问题
            </div>

            <!-- 正词管理 -->
            <div class="pf-words">
              <button class="pf-words-toggle" @click="showWords = !showWords">
                {{ showWords ? '▾' : '▸' }} 正词管理 ({{ proofreadStore.correctWords.length }})
              </button>
              <div v-if="showWords" class="pf-words-body">
                <div class="pf-words-list">
                  <span v-for="w in proofreadStore.correctWords" :key="w" class="pf-word">
                    {{ w }}
                    <button class="pf-word-x" title="删除" @click="removeCorrectWord(w)">✕</button>
                  </span>
                  <span v-if="proofreadStore.correctWords.length === 0" class="pf-words-empty">暂无正词</span>
                </div>
                <div class="pf-words-add">
                  <input v-model="newWord" placeholder="添加正词…" @keyup.enter="addNewWord" />
                  <button class="comment-list-btn" @click="addNewWord">添加</button>
                </div>
              </div>
            </div>

            <!-- 校对底部 -->
            <div class="comment-panel-foot">
              <button class="comment-clear-btn" @click="proofreadStore.clearAll()">🗑 清空校对结果</button>
            </div>
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

    <!-- ── 触发标签（面板关闭时显示，按存在顺序纵向排列） ── -->
    <template v-if="!panelOpen">
      <button
        v-for="(tg, idx) in visibleTriggers"
        :key="tg.key"
        class="panel-trigger"
        :class="tg.cls"
        :style="{ top: (20 + idx * 56) + 'px' }"
        :title="tg.title"
        @click="openTrigger(tg.key)"
      >
        <span class="panel-trigger-icon" v-html="tg.icon"></span>
        <span class="panel-trigger-badge" :class="tg.cls">{{ tg.badge }}</span>
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
.panel-trigger-badge._proofread {
  background: #ef4444;
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
   校对区域
   ═══════════════════════════════════════════════ */
.proofread-panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pf-stat {
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: #374151;
}
.pf-stat.pf-error {
  color: #dc2626;
}
.pf-stat.pf-muted {
  color: #6b7280;
}
.pf-stat.pf-warn {
  color: #b45309;
  white-space: pre-line;
}
.pf-item-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.pf-cat {
  color: #ef4444;
  font-weight: 600;
  flex-shrink: 0;
}
.pf-old {
  text-decoration: line-through;
  opacity: 0.7;
}
.pf-arrow {
  color: #9ca3af;
}
.pf-new {
  color: #059669;
  font-weight: 600;
}
.pf-reason {
  margin-top: 2px;
  font-size: 11px;
  color: #6b7280;
  line-height: 1.45;
}
/* 正词管理 */
.pf-words {
  flex-shrink: 0;
  border-top: 1px solid #e5e7eb;
  padding: 6px 10px;
}
.pf-words-toggle {
  background: transparent;
  border: none;
  font-size: 11px;
  font-weight: 500;
  color: #6b7280;
  cursor: pointer;
  padding: 0;
}
.pf-words-body {
  margin-top: 6px;
}
.pf-words-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pf-word {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px 1px 6px;
  font-size: 11px;
  background: rgba(5, 150, 105, 0.1);
  border: 1px solid rgba(5, 150, 105, 0.25);
  border-radius: 999px;
  color: #047857;
}
.pf-word-x {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 10px;
  color: #047857;
  line-height: 1;
  padding: 0 1px;
}
.pf-word-x:hover {
  color: #dc2626;
}
.pf-words-empty {
  font-size: 11px;
  color: #9ca3af;
}
.pf-words-add {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.pf-words-add input {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  padding: 2px 5px;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  background: #fff;
  color: inherit;
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
.comment-list-item.is-editing .comment-list-order {
  display: none;
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

.dark .pf-stat {
  color: #e5e7eb;
}
.dark .pf-stat.pf-error {
  color: #fca5a5;
}
.dark .pf-stat.pf-muted {
  color: #94a3b8;
}
.dark .pf-stat.pf-warn {
  color: #fbbf24;
}
.dark .pf-cat {
  color: #f87171;
}
.dark .pf-new {
  color: #34d399;
}
.dark .pf-reason {
  color: #94a3b8;
}
.dark .pf-words {
  border-top-color: #334155;
}
.dark .pf-words-toggle {
  color: #94a3b8;
}
.dark .pf-word {
  background: rgba(52, 211, 153, 0.12);
  border-color: rgba(52, 211, 153, 0.3);
  color: #6ee7b7;
}
.dark .pf-word-x {
  color: #6ee7b7;
}
.dark .pf-word-x:hover {
  color: #fca5a5;
}
.dark .pf-words-empty {
  color: #64748b;
}
.dark .pf-words-add input {
  background: #0f172a;
  border-color: #475569;
  color: #e5e7eb;
}
</style>
