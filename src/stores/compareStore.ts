import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { computeDiff } from '../utils/diff'
import type { DiffChunk } from '../utils/diff'

// ── 类型 ──────────────────────────────────────────────────────

export interface CompareEntry {
  id: string
  label: string
  text: string
  createdAt: number
}

export interface CompareSession {
  id: string
  label: string
  entries: CompareEntry[]
  leftId: string | null
  rightId: string | null
  createdAt: number
}

interface StoredData {
  sessions: CompareSession[]
}

// ── localStorage 辅助 ────────────────────────────────────────

const STORAGE_PREFIX = 'aipen_compare_'

function storageKey(docId: string): string {
  return STORAGE_PREFIX + docId
}

// ── ID 生成 ───────────────────────────────────────────────────

let _nextId = 1
function genId(): string {
  return `ce_${_nextId++}_${Date.now().toString(36)}`
}

let _nextSessionNum = 1
function nextSessionLabel(): string {
  return `比对 #${_nextSessionNum++}`
}

// ── Store ─────────────────────────────────────────────────────

export const useCompareStore = defineStore('compare', () => {
  // ── 面板状态（与批注面板共用） ──
  const panelOpen = ref(false)
  const activeTab = ref<'comment' | 'compare'>('comment')

  // ── 当前比对（内存，不持久化） ──
  const entries = ref<CompareEntry[]>([])
  const leftId = ref<string | null>(null)
  const rightId = ref<string | null>(null)
  /** 当前 entries 是否从某个历史会话恢复而来（防止重复存档） */
  const loadedFromId = ref<string | null>(null)

  // ── 查看历史时的"返回当前" ──
  /** 加载历史前，暂存当前 entries 的快照，供"返回当前比对"恢复 */
  interface Snapshot {
    entries: CompareEntry[]
    leftId: string | null
    rightId: string | null
  }
  const previousState = ref<Snapshot | null>(null)

  /** 查看历史时是否有可返回的"当前"状态 */
  const canRestore = computed(() => previousState.value !== null && loadedFromId.value !== null)
  const sessions = ref<CompareSession[]>([])

  // ── 持久化 ──
  const docId = ref<string>('')

  function loadFromStorage(id: string) {
    try {
      const raw = localStorage.getItem(storageKey(id))
      if (!raw) return
      const data = JSON.parse(raw) as StoredData
      if (!Array.isArray(data.sessions)) return
      sessions.value = data.sessions
    } catch {
      // 数据损坏，静默丢弃
    }
  }

  function saveSessions() {
    if (!docId.value) return
    try {
      if (sessions.value.length === 0) {
        localStorage.removeItem(storageKey(docId.value))
        return
      }
      const data: StoredData = { sessions: sessions.value }
      localStorage.setItem(storageKey(docId.value), JSON.stringify(data))
    } catch {
      // 存储满，静默丢弃
    }
  }

  /** 切换文档：当前比对（仅新鲜条目）存档 → 清空 → 加载新文档历史 */
  function initDoc(id: string) {
    if (id === docId.value) return

    // 当前有新鲜条目（非从历史恢复）→ 存入历史
    if (docId.value && entries.value.length > 0 && !loadedFromId.value) {
      archiveCurrent()
    }

    // 清空当前
    entries.value = []
    leftId.value = null
    rightId.value = null
    loadedFromId.value = null
    previousState.value = null
    panelOpen.value = false
    activeTab.value = 'comment'

    // 加载新文档
    docId.value = id
    sessions.value = []
    _nextSessionNum = 1
    if (id) {
      loadFromStorage(id)
      // 恢复序号
      _nextSessionNum = sessions.value.length + 1
    }
  }

  /** 清空当前比对，关闭面板。
   *  若从历史恢复 → 仅重置（不存档）；否则先存档再重置。 */
  function clearSession() {
    if (entries.value.length === 0) return
    if (!loadedFromId.value) {
      // 新鲜条目 → 存档到历史
      archiveCurrent()
    }
    // 从历史恢复的条目或已存档 → 直接清空
    entries.value = []
    leftId.value = null
    rightId.value = null
    loadedFromId.value = null
    previousState.value = null
    panelOpen.value = false
    activeTab.value = 'comment'
  }

  /** 将当前 entries 存入历史（不改变 entries） */
  function archiveCurrent() {
    // 标签：取第一个条目的前15字
    const first = entries.value[0]
    const prefix = first ? (first.text.length > 15 ? first.text.slice(0, 15) + '…' : first.text) : ''
    const session: CompareSession = {
      id: genId(),
      label: prefix || nextSessionLabel(),
      entries: JSON.parse(JSON.stringify(entries.value)),
      leftId: leftId.value,
      rightId: rightId.value,
      createdAt: Date.now(),
    }
    sessions.value.unshift(session)
    saveSessions()
  }

  /** 从历史加载一个会话（自动暂存当前条目，可返回） */
  function loadSession(id: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (!session) return

    // 暂存当前条目，供"返回当前比对"
    if (entries.value.length > 0 && !loadedFromId.value) {
      previousState.value = {
        entries: JSON.parse(JSON.stringify(entries.value)),
        leftId: leftId.value,
        rightId: rightId.value,
      }
    }

    entries.value = JSON.parse(JSON.stringify(session.entries))
    leftId.value = session.leftId
    rightId.value = session.rightId
    loadedFromId.value = id
    // 直接打开面板（不用 openTab 避免 toggle）
    panelOpen.value = true
    activeTab.value = 'compare'
  }

  /** 从历史视图返回到加载前的当前比对 */
  function restorePrevious() {
    if (!previousState.value) return
    entries.value = JSON.parse(JSON.stringify(previousState.value.entries))
    leftId.value = previousState.value.leftId
    rightId.value = previousState.value.rightId
    loadedFromId.value = null
    previousState.value = null
  }

  /** 删除一个历史会话 */
  function deleteSession(id: string) {
    sessions.value = sessions.value.filter((s) => s.id !== id)
    saveSessions()
  }

  // ── 计算属性 ──
  const hasEntries = computed(() => entries.value.length > 0)
  const entryCount = computed(() => entries.value.length)
  const hasHistory = computed(() => sessions.value.length > 0)

  const leftEntry = computed(() =>
    entries.value.find((e) => e.id === leftId.value) ?? null,
  )

  const rightEntry = computed(() =>
    entries.value.find((e) => e.id === rightId.value) ?? null,
  )

  const diffResult = computed<DiffChunk[] | null>(() => {
    const l = leftEntry.value
    const r = rightEntry.value
    if (!l || !r) return null
    return computeDiff(l.text, r.text)
  })

  // ── 自动选择左右 ──
  function autoSelect() {
    const validLeft = leftId.value && entries.value.find((e) => e.id === leftId.value)
    const validRight = rightId.value && entries.value.find((e) => e.id === rightId.value)
    if (entries.value.length >= 1 && !validLeft) {
      leftId.value = entries.value[0].id
    }
    if (entries.value.length >= 2 && !validRight) {
      const alt = entries.value.find((e) => e.id !== leftId.value)
      rightId.value = alt ? alt.id : entries.value[1].id
    }
  }

  // ── 方法 ──
  function addEntry(text: string, label = '手动粘贴') {
    const trimmed = text.trim()
    if (!trimmed) return
    const entry: CompareEntry = {
      id: genId(),
      label,
      text: trimmed,
      createdAt: Date.now(),
    }
    entries.value.push(entry)
    loadedFromId.value = null  // 已"污染"，不再与原历史关联
    previousState.value = null
    autoSelect()
    // 第 2 条加入 → 自动打开比对面板
    if (entries.value.length === 2) {
      panelOpen.value = true
      activeTab.value = 'compare'
    }
  }

  function removeEntry(id: string) {
    entries.value = entries.value.filter((e) => e.id !== id)
    if (leftId.value === id) leftId.value = null
    if (rightId.value === id) rightId.value = null
    loadedFromId.value = null  // 修改后不再是原会话
    previousState.value = null
    autoSelect()
    if (entries.value.length === 0) {
      loadedFromId.value = null
      activeTab.value = 'comment'
    }
  }

  function setLeft(id: string) {
    if (rightId.value === id) {
      rightId.value = leftId.value
    }
    leftId.value = id
  }

  function setRight(id: string) {
    if (leftId.value === id) {
      leftId.value = rightId.value
    }
    rightId.value = id
  }

  function openTab(tab: 'comment' | 'compare') {
    if (panelOpen.value && activeTab.value === tab) {
      panelOpen.value = false
    } else {
      panelOpen.value = true
      activeTab.value = tab
    }
  }

  function closePanel() {
    panelOpen.value = false
  }

  function clearAll() {
    entries.value = []
    leftId.value = null
    rightId.value = null
    loadedFromId.value = null
  }

  return {
    // state
    panelOpen,
    activeTab,
    entries,
    leftId,
    rightId,
    sessions,
    // computed
    hasEntries,
    entryCount,
    hasHistory,
    canRestore,
    leftEntry,
    rightEntry,
    diffResult,
    // methods
    initDoc,
    addEntry,
    removeEntry,
    setLeft,
    setRight,
    clearSession,
    loadSession,
    restorePrevious,
    deleteSession,
    openTab,
    closePanel,
    clearAll,
  }
})
