import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
  /** 流式进度文案（CommentListPanel 模板引用，loading 期间显示） */
  const progressMsg = ref('')
  /** 流式期间的警告信息（CommentListPanel 模板引用 .warnings.length） */
  const warnings = ref<string[]>([])
  /** 当前文档 id（initDoc 防重复清） */
  const currentDocId = ref<string>('')

  // ── 流式校对事件监听 ──
  let _unlistenItem: UnlistenFn | null = null
  let _unlistenDone: UnlistenFn | null = null
  /** 轮次 ID：防御新旧流事件混入；每次 runProofread / cancelProofread 自增 */
  let _runId = 0

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

  /** 执行校对：流式 SSE，逐条 JSON 解析渲染；支持取消。manual=true 时显示进度提示 */
  async function runProofread(doc: any, from?: number, to?: number, opts?: { manual?: boolean }) {
    const manual = opts?.manual ?? true

    // 清理上一轮的监听器（旧流事件无监听自然丢弃），开新轮次 ID
    cleanupListeners()
    const runId = ++_runId

    error.value = null
    cleanHint.value = false
    loading.value = true
    progressMsg.value = '校对进行中…'
    warnings.value = []
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
        manualRun.value = false
        return
      }

      // 清空上一轮结果
      items.value = []
      suppressed.value = 0
      let suppressedCount = 0    // 闭包内累积计数
      let receivedCount = 0      // 已接收条数

      // 设置流式事件监听
      _unlistenItem = await listen<RawProofreadItem>('proofread:item', (event) => {
        if (_runId !== runId) return   // 过期事件（来自旧流），丢弃
        const it = event.payload
        if (isCorrectWord(it.original)) {
          suppressedCount++
          return
        }
        const a = map[it.start]
        const b = it.end > 0 ? map[it.end - 1] + 1 : a + 1
        if (a == null || b == null) return
        const id = genId()
        items.value = [...items.value, {
          id,
          category: it.category,
          original: it.original,
          suggestion: it.suggestion,
          reason: it.reason,
          from: a,
          to: Math.max(b, a + 1),
        }]
        receivedCount++
        progressMsg.value = `已发现 ${items.value.length} 处问题…`
      })

      _unlistenDone = await listen<{ ok: boolean; error?: string }>('proofread:done', (event) => {
        if (_runId !== runId) return   // 过期事件（来自旧流/已取消），丢弃
        const { ok, error: errMsg } = event.payload
        suppressed.value = suppressedCount
        progressMsg.value = ''

        // 有结果时打开面板
        if (receivedCount > 0) {
          const compare = useCompareStore()
          compare.panelOpen = true
          compare.activeTab = 'proofread'
        } else if (manual && ok) {
          // 手动校对且无问题：弹"未发现问题"提示
          cleanHint.value = true
          if (_cleanHintTimer) clearTimeout(_cleanHintTimer)
          _cleanHintTimer = setTimeout(() => { cleanHint.value = false }, 2500)
        }

        if (!ok && errMsg) {
          error.value = errMsg
        }

        loading.value = false
        if (manual) manualRun.value = false

        // 清理监听
        cleanupListeners()
      })

      // 触发流式校对（非阻塞 invoke，结果由事件通知）
      await invoke('proofread_stream', { text })
    } catch (e: any) {
      if (loading.value) {
        error.value = typeof e === 'string' ? e : e?.message ?? '校对失败'
        loading.value = false
        if (manual) manualRun.value = false
      }
      cleanupListeners()
    }
  }

  /** 取消当前校对（设置后端取消标志，递增轮次使在途事件失效，清理前端状态） */
  async function cancelProofread() {
    // 递增轮次使所有在途旧事件在 handler 中被 _runId !== runId 过滤掉
    _runId++
    // 通知后端取消
    invoke('cancel_proofread').catch(() => {})
    // 立即清理前端监听和状态
    cleanupListeners()
    loading.value = false
    manualRun.value = false
    progressMsg.value = ''
    warnings.value = []
  }

  /** 清理事件监听器 */
  function cleanupListeners() {
    if (_unlistenItem) { _unlistenItem(); _unlistenItem = null }
    if (_unlistenDone) { _unlistenDone(); _unlistenDone = null }
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
    progressMsg.value = ''
    warnings.value = []
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
    progressMsg.value = ''
    warnings.value = []
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
    progressMsg,
    warnings,
    currentDocId,
    // computed
    hasItems,
    itemCount,
    // methods
    isCorrectWord,
    runProofread,
    cancelProofread,
    ignore,
    addCorrectWord,
    removeCorrectWord,
    updateCorrectWord,
    clearAll,
    remap,
    initDoc,
  }
})
