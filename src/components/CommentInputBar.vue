<script setup lang="ts">
/**
 * 批注输入浮层
 *  - 显示位置由父组件传入（屏幕坐标）
 *  - 输入文字（<= 500 字）→ emit 'confirm'
 *  - Esc/点击取消 → emit 'cancel'
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps<{
  /** 浮层定位：top/left 为屏幕像素 */
  position: { top: number; left: number }
  /** 最大字符数（默认 500） */
  maxLength?: number
}>()

const emit = defineEmits<{
  confirm: [text: string]
  cancel: []
}>()

const text = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const max = props.maxLength ?? 500

onMounted(async () => {
  await nextTick()
  textareaRef.value?.focus()
})

function onConfirm() {
  const v = text.value.trim()
  if (!v) return
  emit('confirm', v.slice(0, max))
}

function onKeyup(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    onConfirm()
  }
}

function onBackdropClick(e: MouseEvent) {
  // 点击浮层内部不关闭，浮层外关闭
  if (e.target === e.currentTarget) emit('cancel')
}
</script>

<template>
  <Teleport to="body">
    <div
      class="comment-input-backdrop"
      @mousedown="onBackdropClick"
    >
      <div
        class="comment-input-bar"
        :style="{ top: `${position.top}px`, left: `${position.left}px` }"
        @mousedown.stop
      >
        <textarea
          ref="textareaRef"
          v-model="text"
          :maxlength="max"
          rows="3"
          class="comment-input-textarea"
          placeholder="写下你的批注…（500 字以内）"
          @keyup="onKeyup"
        />
        <div class="comment-input-footer">
          <span class="comment-input-count">{{ text.length }} / {{ max }}</span>
          <div class="comment-input-actions">
            <button class="comment-input-btn comment-input-btn-cancel" @click="emit('cancel')">取消</button>
            <button
              class="comment-input-btn comment-input-btn-confirm"
              :disabled="!text.trim()"
              @click="onConfirm"
            >✓ 保存</button>
          </div>
        </div>
        <div class="comment-input-hint">Ctrl/⌘+Enter 保存 · Esc 取消</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.comment-input-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: transparent;
}
.comment-input-bar {
  position: fixed;
  z-index: 10000;
  width: 280px;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 8px;
  transform: translate(-50%, 0);
}
.comment-input-textarea {
  width: 100%;
  min-height: 64px;
  max-height: 200px;
  font-size: 13px;
  line-height: 1.5;
  background: transparent;
  color: inherit;
  border: none;
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.comment-input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
  font-size: 11px;
  color: #6b7280;
}
.comment-input-actions {
  display: flex;
  gap: 4px;
}
.comment-input-btn {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color 0.12s;
}
.comment-input-btn-cancel {
  background: transparent;
  color: #6b7280;
}
.comment-input-btn-cancel:hover {
  background: rgba(0, 0, 0, 0.05);
}
.comment-input-btn-confirm {
  background: #2563eb;
  color: #fff;
}
.comment-input-btn-confirm:hover:not(:disabled) {
  background: #1d4ed8;
}
.comment-input-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.comment-input-hint {
  margin-top: 4px;
  font-size: 10px;
  color: #9ca3af;
  text-align: right;
}
</style>

<style>
.dark .comment-input-bar {
  background: #1e293b;
  border-color: #334155;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  color: #e5e7eb;
}
.dark .comment-input-footer {
  color: #94a3b8;
}
.dark .comment-input-btn-cancel {
  color: #94a3b8;
}
.dark .comment-input-btn-cancel:hover {
  background: rgba(255, 255, 255, 0.05);
}
.dark .comment-input-hint {
  color: #64748b;
}
</style>
