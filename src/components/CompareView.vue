<script setup lang="ts">
/**
 * 比对视图 —— 在统一抽屉面板的 "比对" tab 中渲染
 *  - 条目卡片列表（可选原文 / 修改稿）
 *  - "+ 添加比对文本" 按钮 + 输入弹窗
 *  - 内联 Diff 结果渲染
 *  - 清空此轮比对（存档 → 关闭面板）
 *  - 比对历史：面板内时钟图标 → 下拉列表
 */
import { ref } from 'vue'
import { useCompareStore } from '../stores/compareStore'

const store = useCompareStore()

// ── 添加文本弹窗 ──
const showAddModal = ref(false)
const addText = ref('')
const addLabel = ref('手动粘贴')

function openAddModal() {
  addText.value = ''
  addLabel.value = '手动粘贴'
  showAddModal.value = true
}

function confirmAdd() {
  if (addText.value.trim()) {
    store.addEntry(addText.value, addLabel.value)
  }
  showAddModal.value = false
}

function cancelAdd() {
  showAddModal.value = false
}

// ── 比对历史下拉 ──
const showHistory = ref(false)

function toggleHistory() {
  showHistory.value = !showHistory.value
}

function onLoadHistory(sessionId: string) {
  store.loadSession(sessionId)
  showHistory.value = false
}

function onDeleteHistory(sessionId: string) {
  store.deleteSession(sessionId)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="compare-view">
    <!-- ── 条目列表 ── -->
    <div class="compare-entries">
      <div
        v-for="entry in store.entries"
        :key="entry.id"
        class="compare-entry-card"
        :class="{
          'is-left': entry.id === store.leftId,
          'is-right': entry.id === store.rightId,
        }"
      >
        <div class="compare-entry-top">
          <span class="compare-entry-label">{{ entry.label }}</span>
          <span class="compare-entry-time">
            {{ new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
          </span>
          <button class="compare-entry-remove" title="删除此条目" @click="store.removeEntry(entry.id)">✕</button>
        </div>
        <div class="compare-entry-text">
          {{ entry.text.length > 180 ? entry.text.slice(0, 180) + '…' : entry.text }}
        </div>
        <div class="compare-entry-actions">
          <button
            class="compare-select-btn"
            :class="{ active: entry.id === store.leftId }"
            title="设为原文"
            @click="store.setLeft(entry.id)"
          >
            原文
          </button>
          <button
            class="compare-select-btn"
            :class="{ active: entry.id === store.rightId }"
            title="设为修改稿"
            @click="store.setRight(entry.id)"
          >
            修改稿
          </button>
        </div>
      </div>

      <button class="compare-add-btn" @click="openAddModal">
        <span class="compare-add-plus">+</span>
        添加比对文本
      </button>
    </div>

    <!-- ── Diff 结果 ── -->
    <div class="compare-result">
      <div class="compare-result-label">
        <span>差异对比</span>
        <!-- 比对历史按钮 -->
        <button
          v-if="store.hasHistory"
          class="compare-history-btn"
          :class="{ active: showHistory }"
          title="比对历史"
          @click="toggleHistory"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span class="compare-history-badge">{{ store.sessions.length }}</span>
        </button>
      </div>

      <!-- 比对历史下拉列表（面板内） -->
      <div v-if="showHistory && store.hasHistory" class="compare-history-dropdown">
        <div
          v-for="session in store.sessions"
          :key="session.id"
          class="compare-history-item"
          @click="onLoadHistory(session.id)"
        >
          <span class="compare-history-label">{{ session.label }}</span>
          <span class="compare-history-time">{{ fmtTime(session.createdAt) }}</span>
          <span class="compare-history-count">{{ session.entries.length }} 条</span>
          <button
            class="compare-history-del"
            title="删除"
            @click.stop="onDeleteHistory(session.id)"
          >✕</button>
        </div>
      </div>

      <!-- 返回当前比对 -->
      <div v-if="store.canRestore" class="compare-restore-bar">
        <span class="compare-restore-text">📋 正在查看历史比对</span>
        <button class="compare-restore-btn" @click="store.restorePrevious()">返回当前</button>
      </div>

      <div v-if="store.entries.length < 2" class="compare-empty">
        请添加至少 2 条文本进行比对
      </div>
      <div v-else-if="!store.leftId || !store.rightId" class="compare-empty">
        请为两条文本分别指定"原文"和"修改稿"
      </div>
      <div v-else-if="store.diffResult && store.diffResult.length === 0" class="compare-empty">
        两份文本内容完全相同
      </div>
      <div v-else-if="store.diffResult" class="compare-diff-content">
        <template v-for="(chunk, i) in store.diffResult" :key="i">
          <span v-if="chunk.kind === 'keep'">{{ chunk.oldText }}</span>
          <span v-else-if="chunk.kind === 'delete'" class="diff-del">{{ chunk.oldText }}</span>
          <span v-else-if="chunk.kind === 'insert'" class="diff-ins">{{ chunk.newText }}</span>
          <template v-else-if="chunk.kind === 'replace'">
            <span class="diff-del">{{ chunk.oldText }}</span>
            <span class="diff-ins">{{ chunk.newText }}</span>
          </template>
        </template>
      </div>
    </div>

    <!-- ── 清空此轮比对 ── -->
    <div v-if="store.hasEntries" class="compare-clear-bar">
      <button class="compare-clear-btn" @click="store.clearSession()">
        🗑 清空此轮比对
      </button>
    </div>

    <!-- ── 添加文本弹窗 ── -->
    <Teleport to="body">
      <div v-if="showAddModal" class="compare-modal-overlay" @click.self="cancelAdd">
        <div class="compare-modal">
          <div class="compare-modal-title">添加比对文本</div>
          <textarea
            v-model="addText"
            class="compare-modal-textarea"
            placeholder="在此粘贴或输入要比对的文本…"
            rows="8"
            @keyup.esc="cancelAdd"
          />
          <div class="compare-modal-actions">
            <button class="compare-modal-btn _cancel" @click="cancelAdd">取消</button>
            <button class="compare-modal-btn _confirm" :disabled="!addText.trim()" @click="confirmAdd">添加</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* =============================================
   比对视图（在 CommentListPanel 面板内部）
   高度撑满面板剩余空间，内部滚动
   ============================================= */
.compare-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* -- 条目区域 -- */
.compare-entries {
  padding: 6px 10px;
  overflow-y: auto;
  flex-shrink: 0;
  max-height: 50%;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.compare-entry-card {
  padding: 5px 7px;
  border-radius: 4px;
  border: 1px solid #e5e7eb;
  background: #fafbfc;
  font-size: 12px;
  transition: border-color 0.15s;
}
.compare-entry-card.is-left {
  border-color: #bfdbfe;
  background: #f8faff;
}
.compare-entry-card.is-right {
  border-color: #fecaca;
  background: #fef9f9;
}

.compare-entry-top {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}
.compare-entry-label {
  font-weight: 600;
  font-size: 10px;
  color: #374151;
}
.compare-entry-time {
  font-size: 9px;
  color: #9ca3af;
  flex: 1;
}
.compare-entry-remove {
  background: transparent;
  border: none;
  font-size: 11px;
  color: #9ca3af;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  border-radius: 2px;
}
.compare-entry-remove:hover {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
}

.compare-entry-text {
  color: #4b5563;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 67px;
  overflow-y: auto;
  text-align: justify;
}

.compare-entry-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.compare-select-btn {
  flex: 1;
  padding: 2px 6px;
  font-size: 10px;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.12s;
  text-align: center;
}
.compare-select-btn:hover {
  background: #f3f4f6;
  color: #374151;
}
.compare-select-btn.active {
  border-color: #93c5fd;
  background: #eff6ff;
  color: #3b82f6;
  font-weight: 600;
}

/* -- 添加按钮 -- */
.compare-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 100%;
  padding: 6px 0;
  font-size: 11px;
  color: #6b7280;
  background: transparent;
  border: 1px dashed #d1d5db;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.12s;
}
.compare-add-btn:hover {
  border-color: #2563eb;
  color: #2563eb;
  background: #eff6ff;
}
.compare-add-plus {
  font-size: 14px;
  font-weight: 300;
  line-height: 1;
}

/* -- Diff 结果区域 -- */
.compare-result {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #e5e7eb;
  overflow: hidden;
}
.compare-result-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  font-size: 10px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: #f9fafb;
  border-bottom: 1px solid #f3f4f6;
  flex-shrink: 0;
}

/* -- 比对历史图标按钮 -- */
.compare-history-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 4px;
  cursor: pointer;
  color: #9ca3af;
  transition: all 0.12s;
}
.compare-history-btn svg {
  width: 13px;
  height: 13px;
}
.compare-history-btn:hover,
.compare-history-btn.active {
  color: #6b7280;
  background: rgba(0, 0, 0, 0.04);
}
.compare-history-badge {
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  background: #9333ea;
  min-width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 0 3px;
  line-height: 1;
}

/* -- 比对历史下拉列表 -- */
.compare-history-dropdown {
  max-height: 180px;
  overflow-y: auto;
  border-bottom: 1px solid #e5e7eb;
  background: #fff;
  flex-shrink: 0;
}
.compare-history-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-bottom: 1px solid #f3f4f6;
  cursor: pointer;
  transition: background 0.12s;
}
.compare-history-item:last-child {
  border-bottom: none;
}
.compare-history-item:hover {
  background: #f9fafb;
}
.compare-history-label {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 500;
  color: #374151;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.compare-history-time {
  flex-shrink: 0;
  font-size: 9px;
  color: #9ca3af;
}
.compare-history-count {
  flex-shrink: 0;
  font-size: 9px;
  color: #9ca3af;
}
.compare-history-del {
  flex-shrink: 0;
  background: transparent;
  border: none;
  font-size: 11px;
  color: #9ca3af;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
}
.compare-history-del:hover {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
}
.compare-restore-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
  flex-shrink: 0;
}
.compare-restore-text {
  font-size: 10px;
  color: #92400e;
  font-weight: 500;
}
.compare-restore-btn {
  font-size: 10px;
  font-weight: 500;
  color: #2563eb;
  background: transparent;
  border: 1px solid #93c5fd;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  transition: all 0.12s;
}
.compare-restore-btn:hover {
  background: #eff6ff;
  color: #1d4ed8;
}
.compare-empty {
  padding: 20px 10px;
  text-align: center;
  font-size: 11px;
  color: #9ca3af;
}
.compare-diff-content {
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  color: #374151;
  text-align: justify;
}

/* -- Diff 行内样式 -- */
.diff-del {
  color: #6b7280;
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
  text-decoration-color: #94a3b8;
  background: rgba(107, 114, 128, 0.06);
  padding: 0 1px;
  border-radius: 2px;
}
.diff-ins {
  color: #b45309;
  background: rgba(180, 83, 9, 0.06);
  padding: 0 1px;
  border-radius: 2px;
  font-weight: 500;
}

/* -- 弹窗 -- */
.compare-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(2px);
}
.compare-modal {
  width: 420px;
  max-width: 90vw;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.15);
  padding: 16px 20px;
}
.compare-modal-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 10px;
}
.compare-modal-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  resize: vertical;
  font-family: inherit;
  color: #1f2937;
  background: #fff;
  outline: none;
}
.compare-modal-textarea:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
}
.compare-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.compare-modal-btn {
  padding: 5px 16px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid #d1d5db;
  cursor: pointer;
  transition: all 0.12s;
}
.compare-modal-btn._cancel {
  background: #fff;
  color: #6b7280;
}
.compare-modal-btn._cancel:hover {
  background: #f3f4f6;
}
.compare-modal-btn._confirm {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}
.compare-modal-btn._confirm:hover:not(:disabled) {
  background: #1d4ed8;
}
.compare-modal-btn._confirm:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* -- 清空此轮比对 -- */
.compare-clear-bar {
  padding: 6px 10px;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.compare-clear-btn {
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
.compare-clear-btn:hover {
  background: rgba(220, 38, 38, 0.06);
  border-color: rgba(220, 38, 38, 0.4);
}


</style>

<!-- 深色模式（非 scoped，与 CommentListPanel 完全一致的方式） -->
<style>
.dark .compare-entries {
  scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
}
.dark .compare-entry-card {
  border-color: #334155;
  background: #1a1d2e;
}
.dark .compare-entry-card.is-left {
  border-color: rgba(96, 165, 250, 0.18);
  background: rgba(96, 165, 250, 0.04);
}
.dark .compare-entry-card.is-right {
  border-color: rgba(252, 165, 165, 0.18);
  background: rgba(252, 165, 165, 0.04);
}
.dark .compare-entry-label {
  color: #e5e7eb;
}
.dark .compare-entry-time {
  color: #64748b;
}
.dark .compare-entry-remove {
  color: #475569;
}
.dark .compare-entry-remove:hover {
  color: #fca5a5;
  background: rgba(252, 165, 165, 0.12);
}
.dark .compare-entry-text {
  color: #cbd5e1;
}
.dark .compare-select-btn {
  background: #1e2030;
  border-color: #475569;
  color: #94a3b8;
}
.dark .compare-select-btn:hover {
  background: #2a2d3e;
  color: #e5e7eb;
}
.dark .compare-select-btn.active {
  border-color: rgba(96, 165, 250, 0.25);
  background: rgba(96, 165, 250, 0.08);
  color: #93c5fd;
}
.dark .compare-add-btn {
  border-color: #334155;
  color: #94a3b8;
}
.dark .compare-add-btn:hover {
  border-color: #60a5fa;
  color: #93c5fd;
  background: rgba(59, 130, 246, 0.08);
}
.dark .compare-result {
  border-top-color: #334155;
}
.dark .compare-result-label {
  background: #1a1d2e;
  border-bottom-color: #1e293b;
  color: #94a3b8;
}
.dark .compare-empty {
  color: #94a3b8;
}
.dark .compare-diff-content {
  color: #e2e8f0;
  scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
}
.dark .diff-del {
  color: #94a3b8;
  text-decoration-color: #64748b;
  background: rgba(148, 163, 184, 0.08);
}
.dark .diff-ins {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.1);
}
.dark .compare-modal {
  background: #1e2030;
  border: 1px solid #334155;
}
.dark .compare-modal-title {
  color: #e5e7eb;
}
.dark .compare-modal-textarea {
  background: #0f172a;
  border-color: #475569;
  color: #e5e7eb;
}
.dark .compare-modal-textarea:focus {
  border-color: #60a5fa;
}
.dark .compare-modal-btn._cancel {
  background: #1a1d2e;
  border-color: #475569;
  color: #94a3b8;
}
.dark .compare-modal-btn._cancel:hover {
  background: #2a2d3e;
  color: #e5e7eb;
}
.dark .compare-modal-btn._confirm {
  background: #2563eb;
  border-color: #3b82f6;
  color: #fff;
}
.dark .compare-modal-btn._confirm:hover:not(:disabled) {
  background: #3b82f6;
}
.dark .compare-clear-bar {
  border-top-color: #334155;
}
.dark .compare-clear-btn {
  color: #94a3b8;
  border-color: rgba(255, 255, 255, 0.08);
}
.dark .compare-clear-btn:hover {
  color: #fca5a5;
  background: rgba(252, 165, 165, 0.08);
  border-color: rgba(252, 165, 165, 0.3);
}

.dark .compare-history-btn {
  color: #64748b;
}
.dark .compare-history-btn:hover,
.dark .compare-history-btn.active {
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.06);
}
.dark .compare-history-dropdown {
  background: #1a1d2e;
  border-bottom-color: #334155;
}
.dark .compare-history-item {
  border-bottom-color: #1e293b;
}
.dark .compare-history-item:hover {
  background: rgba(255, 255, 255, 0.03);
}
.dark .compare-history-label {
  color: #e5e7eb;
}
.dark .compare-history-time,
.dark .compare-history-count {
  color: #64748b;
}
.dark .compare-history-del {
  color: #64748b;
}
.dark .compare-history-del:hover {
  color: #fca5a5;
  background: rgba(252, 165, 165, 0.1);
}

.dark .compare-restore-bar {
  background: rgba(251, 191, 36, 0.08);
  border-bottom-color: rgba(251, 191, 36, 0.2);
}
.dark .compare-restore-text {
  color: #fcd34d;
}
.dark .compare-restore-btn {
  color: #93c5fd;
  border-color: rgba(96, 165, 250, 0.25);
}
.dark .compare-restore-btn:hover {
  background: rgba(96, 165, 250, 0.1);
  color: #bfdbfe;
}
</style>
