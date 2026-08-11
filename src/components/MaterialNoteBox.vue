<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useMaterialStore } from '../stores/materialStore'

import type { MaterialNote } from '../stores/materialStore'

const props = defineProps<{ materialId: string }>()

const materialStore = useMaterialStore()
const draft = ref('')
const editingId = ref<string | null>(null)
const editingContent = ref('')
/** 本卡片自己的碎念列表（标签视图下多张卡片各自独立，不共用全局 store 列表） */
const notes = ref<MaterialNote[]>([])
/** 输入框默认隐藏；外层 💭 按钮调用时展开 */
const inputVisible = ref(false)
/** 折叠：收起碎念列表，仅留顶部小横条 */
const collapsed = ref(false)

// 碎念条数越多，爱心略大（封顶 18px，避免过大）
const encouragementSize = computed(() => {
  const n = notes.value.length
  if (n >= 5) return 18
  if (n >= 3) return 15
  return 13
})

// 每条碎念一句鼓励语，按索引稳定映射（刷新不跳变）
const ENCOURAGES = [
  '这条碎念真暖 💛',
  '记下了，棒 🌟',
  '你写得真好 ✨',
  '灵感碎片 +1 🧩',
  '生活的温度 💛',
  '烂笔头胜过好记性 📝',
  '这一段很有灵气 🌿',
  '又攒了一段心事 🌿',
]
function encourageFor(index: number) {
  return ENCOURAGES[index % ENCOURAGES.length]
}

/** 碎念时间格式化兜底：后端用 datetime('now') 存保存时刻，原始值如 2026-07-31 12:34:56。
 *  若后端偶发未带值，则回退显示「刚刚」，保证显示的时间一定正确可读。 */
function formatNoteTime(raw: string | undefined): string {
  if (!raw) return '刚刚'
  return raw
}

async function load() {
  notes.value = await materialStore.loadNotes(props.materialId)
}
watch(() => props.materialId, (id) => { if (id) load() }, { immediate: true })

/** 外层 💭 碎念按钮只负责让输入框出现 */
function openInput() {
  collapsed.value = false
  inputVisible.value = true
}
async function addNote() {
  const content = draft.value.trim()
  if (!content) return
  if (!props.materialId) {
    console.warn('[碎念] 未取得素材 id，无法保存')
    return
  }
  notes.value = await materialStore.addNote(props.materialId, content)
  draft.value = ''
  inputVisible.value = false
}
function startEdit(note: { id: string; content: string }) {
  editingId.value = note.id
  editingContent.value = note.content
}
async function saveEdit() {
  if (editingId.value === null) return
  const id = editingId.value
  const content = editingContent.value.trim()
  await materialStore.updateNote(id, content)
  const hit = notes.value.find(n => n.id === id)
  if (hit) hit.content = content
  editingId.value = null
}
async function removeNote(note: { id: string }) {
  notes.value = await materialStore.deleteNote(note.id, props.materialId)
}

defineExpose({ openInput })
</script>

<template>
  <section class="material-notes">
    <!-- 有碎念：顶部条（条数 + 收起）+ 列表 -->
    <template v-if="notes.length > 0">
      <div class="mn-bar">
        <span class="mn-heart" :style="{ fontSize: encouragementSize + 'px' }">💛</span>
        <span class="mn-count">碎念 · {{ notes.length }}</span>
        <button class="mn-toggle" @click="collapsed = !collapsed">
          {{ collapsed ? '展开' : '收起' }}
        </button>
      </div>

      <div v-show="!collapsed">
        <ul class="mn-list">
          <li v-for="(note, i) in notes" :key="note.id" class="mn-item">
            <template v-if="editingId === note.id">
              <textarea v-model="editingContent" rows="2"></textarea>
              <button class="mn-save" @click="saveEdit">保存</button>
            </template>
            <template v-else>
              <p class="mn-content">{{ note.content }}</p>
              <div class="mn-meta">
                <span class="mn-encourage">💛 {{ encourageFor(i) }}</span>
                <span class="mn-time">🕒 {{ formatNoteTime(note.created_at) }}</span>
                <button class="mn-edit" title="编辑" @click="startEdit(note)">✎</button>
                <button class="mn-del" title="删除" @click="removeNote(note)">🗑</button>
              </div>
            </template>
          </li>
        </ul>

        <div v-if="inputVisible" class="mn-input">
          <textarea v-model="draft" rows="2" placeholder="写下你的碎念…"></textarea>
          <button class="mn-add" @click="addNote">添加</button>
        </div>
      </div>
    </template>

    <!-- 无碎念：极简空状态，只留一条提示 + 写第一条 -->
    <template v-else>
      <div class="mn-empty-bar">
        <span class="mn-heart">💛</span>
        <span class="mn-empty-tip">还没有碎念，写下第一条吧～</span>
      </div>
      <div v-if="inputVisible" class="mn-input">
        <textarea v-model="draft" rows="2" placeholder="写下你的碎念…"></textarea>
        <button class="mn-add" @click="addNote">添加</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.material-notes {
  margin-top: 12px;
  padding: 0 12px 12px; /* 底部留白：碎念不再贴卡片底边 */
  font-size: 13px;
  color: #334155;
}
.mn-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid rgba(99, 102, 241, 0.18);
}
.mn-heart {
  line-height: 1;
  transition: font-size 0.25s ease;
}
.mn-count {
  font-weight: 600;
  color: #4f46e5;
}
.mn-toggle {
  margin-left: auto;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 3px 10px;
  background: transparent;
  color: #475569;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.mn-toggle:hover {
  background: #f1f5f9;
}
.mn-empty-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid rgba(99, 102, 241, 0.18);
}
.mn-empty-tip {
  color: #94a3b8;
  font-size: 12px;
}
.mn-input {
  display: flex;
  gap: 8px;
  align-items: stretch;
  margin: 10px 0;
}
.mn-input textarea {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  resize: vertical;
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
.mn-input textarea:focus {
  border-color: #6366f1;
}
.mn-add {
  padding: 0 18px;
  border: none;
  border-radius: 8px;
  background: #6366f1;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.mn-add:hover {
  background: #4f46e5;
}
.mn-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mn-item {
  padding: 10px 12px;
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.05); /* 柔和淡紫，不再硬白 #fff */
}
.mn-item textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  resize: vertical;
  font-family: inherit;
  font-size: 13px;
  box-sizing: border-box;
}
.mn-content {
  margin: 0 0 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
.mn-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mn-encourage {
  flex: 1;
  font-size: 12px;
  color: #f59e0b;
}
.mn-time {
  font-size: 12px;
  color: #94a3b8;
}
.mn-edit,
.mn-del,
.mn-save {
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
}
.mn-edit {
  color: #4f46e5;
}
.mn-edit:hover {
  background: #eef2ff;
}
.mn-del {
  color: #b91c1c;
}
.mn-del:hover {
  background: #fef2f2;
}
.mn-save {
  color: #047857;
}
.mn-save:hover {
  background: #ecfdf5;
}
</style>
