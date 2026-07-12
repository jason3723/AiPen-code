import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useCompareStore } from './compareStore'
import { buildPlainTextAndMapRange } from '../utils/docOffset'

// ── 类型 ──────────────────────────────────────────────────────

/** 后端 RawProofreadItem（字符偏移版本） */
interface RawProofreadItem {
  category: string
  start: number
  end: number
  original: string
  suggestion: string
  reason: string
}

/** 前端校对项（已映射为文档绝对位置 from/to） */
export interface ProofreadIssue {
  id: string
  category: string
  original: string
  suggestion: string
  reason: string
  /** 绝对文档位置（含） */
  from: number
  /** 绝对文档位置（不含） */
  to: number
}

// ── 正词持久化（全局，不按文档隔离） ────────────────────────
const CORRECT_WORDS_KEY = 'aipen_proofread_correct_words'

function loadCorrectWords(): string[] {
  try {
    const raw = localStorage.getItem(CORRECT_WORDS_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string')
    }
  } catch {
    // 数据损坏，静默丢弃
  }
  return []
}

function saveCorrectWords(words: string[]) {
  try {
    localStorage.setItem(CORRECT_WORDS_KEY, JSON.stringify(words))
  } catch {
    // 存储满，静默丢弃
  }
}

let _nextId = 1
function genId(): string {
  return `pf_${_nextId++}_${Date.now().toString(36)}`
}

// ── Store ─────────────────────────────────────────────────────
export const useProofreadStore = defineStore('proofread', () => {
  /** 当前校对结果（已映射为文档位置） */
  const items = ref<ProofreadIssue[]>([])
  /** 正词（全局，用户声明为正确的词，用于抑制误报） */
  const correctWords = ref<string[]>(loadCorrectWords())
  const loading = ref(false)
  /** 手动点击校对进行中：仅用于"面板弹出前"的进度提示（自动重校不置位，避免频繁弹提示） */
  const manualRun = ref(false)
  /** 手动校对后"未发现问题"提示：置位后由定时器自动清除（窗口自毁） */
  const cleanHint = ref(false)
  let _cleanHintTimer: ReturnType<typeof setTimeout> | null = null
  const error = ref<string | null>(null)
  /** 本次运行中被正词抑制掉的条数（用于面板提示） */
  const suppressed = ref(0)
  /** 当前文档 id（initDoc 防重复清） */
  const currentDocId = ref<string>('')

  const hasItems = computed(() => items.value.length > 0)
  const itemCount = computed(() => items.value.length)

  function norm(s: string): string {
    return s.trim()
  }

  /** 是否为正词（忽略大小写/首尾空白的精确匹配） */
  function isCorrectWord(s: string): boolean {
    const t = norm(s)
    return correctWords.value.some((w) => norm(w) === t)
  }

  /** 执行校对：传入 ProseMirror doc；可选选区范围（含则只校选区）。manual=true 时显示"面板弹出前"进度提示 */
  async function runProofread(doc: any, from?: number, to?: number, opts?: { manual?: boolean }) {
    const manual = opts?.manual ?? true
    error.value = null
    cleanHint.value = false
    loading.value = true
    if (manual) manualRun.value = true
    try {
      const size = doc?.content?.size ?? 0
      const f = from ?? 0
      const t = to ?? size
      const { text, map } = buildPlainTextAndMapRange(doc, f, t)
      if (!text.trim()) {
        items.value = []
        suppressed.value = 0
        loading.value = false
        return
      }

      const raw = await invoke<RawProofreadItem[]>('proofread', { text })

      const issues: ProofreadIssue[] = []
      let suppressedCount = 0
      for (const it of raw) {
        if (isCorrectWord(it.original)) {
          suppressedCount++
          continue
        }
        const a = map[it.start]
        const b = it.end > 0 ? map[it.end - 1] + 1 : a + 1
        if (a == null || b == null) continue
        issues.push({
          id: genId(),
          category: it.category,
          original: it.original,
          suggestion: it.suggestion,
          reason: it.reason,
          from: a,
          to: Math.max(b, a + 1),
        })
      }

      items.value = issues
      suppressed.value = suppressedCount

      // 有结果才打开面板（复用统一抽屉）
      if (issues.length > 0) {
        const compare = useCompareStore()
        compare.panelOpen = true
        compare.activeTab = 'proofread'
      } else if (manual) {
        // 手动校对且无问题：弹"未发现问题"提示，约 2.5 秒后自动销毁
        cleanHint.value = true
        if (_cleanHintTimer) clearTimeout(_cleanHintTimer)
        _cleanHintTimer = setTimeout(() => { cleanHint.value = false }, 2500)
      }
    } catch (e: any) {
      error.value = typeof e === 'string' ? e : e?.message ?? '校对失败'
    } finally {
      loading.value = false
      if (manual) manualRun.value = false
    }
  }

  /** 忽略一条（从结果列表移除） */
  function ignore(id: string) {
    items.value = items.value.filter((i) => i.id !== id)
  }

  /** 新增正词：实时抑制命中该项的结果 */
  function addCorrectWord(w: string) {
    const t = norm(w)
    if (!t || isCorrectWord(t)) return
    correctWords.value = [...correctWords.value, t]
    saveCorrectWords(correctWords.value)
    items.value = items.value.filter((i) => !isCorrectWord(i.original))
  }

  /** 删除正词 */
  function removeCorrectWord(w: string) {
    correctWords.value = correctWords.value.filter((x) => x !== w)
    saveCorrectWords(correctWords.value)
  }

  /** 编辑正词（空则视为删除） */
  function updateCorrectWord(oldW: string, newW: string) {
    const t = norm(newW)
    if (!t) {
      removeCorrectWord(oldW)
      return
    }
    correctWords.value = correctWords.value.map((x) => (x === oldW ? t : x))
    saveCorrectWords(correctWords.value)
    items.value = items.value.filter((i) => !isCorrectWord(i.original))
  }

  /** 清空校对结果并收起面板（trigger 因 hasItems=false 自动消失） */
  function clearAll() {
    items.value = []
    suppressed.value = 0
    const compare = useCompareStore()
    compare.panelOpen = false
  }

  /**
   * 文档变更后重映射 items 的 from/to（删除命中编辑区间的项在 RichEditor 侧完善）。
   * mapping 为 ProseMirror Mapping 对象（tr.mapping）。
   */
  function remap(mapping: any) {
    if (!mapping || typeof mapping.map !== 'function') return
    const next: ProofreadIssue[] = []
    for (const it of items.value) {
      const from = mapping.map(it.from, -1)
      const to = mapping.map(it.to, 1)
      if (from == null || to == null || to <= from) continue
      next.push({ ...it, from, to })
    }
    items.value = next
  }

  /** 切换文档：清空校对结果（正词为全局，不清）；幂等 */
  function initDoc(id: string) {
    if (id === currentDocId.value) return
    currentDocId.value = id
    items.value = []
    suppressed.value = 0
  }

  return {
    // state
    items,
    correctWords,
    loading,
    manualRun,
    cleanHint,
    error,
    suppressed,
    currentDocId,
    // computed
    hasItems,
    itemCount,
    // methods
    isCorrectWord,
    runProofread,
    ignore,
    addCorrectWord,
    removeCorrectWord,
    updateCorrectWord,
    clearAll,
    remap,
    initDoc,
  }
})
