<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import * as Vue from 'vue'
import CommentInputBar from './CommentInputBar.vue'
import CommentListPanel from './CommentListPanel.vue'
import CommentTooltip from './CommentTooltip.vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import { Mark, Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { CellSelection } from 'prosemirror-tables'
import StarterKit from '@tiptap/starter-kit'
import BulletList from '@tiptap/extension-bullet-list'
import OrderedList from '@tiptap/extension-ordered-list'
import ListItem from '@tiptap/extension-list-item'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import ImageExt from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import FontFamily from '@tiptap/extension-font-family'
import Color from '@tiptap/extension-color'
import Superscript from '@tiptap/extension-superscript'
import Subscript from '@tiptap/extension-subscript'
import { Typography } from '@tiptap/extension-typography'
import { appLocalDataDir, join } from '@tauri-apps/api/path'
// fs 插件不再直接使用（图片读写通过 Rust 自定义命令，避免权限范围问题）
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useDocumentStore } from '../stores/document'
import { useMaterialStore } from '../stores/materialStore'
import { useCandidateStore } from '../stores/candidateStore'
import { useCompareStore } from '../stores/compareStore'
import { useProofreadStore } from '../stores/proofreadStore'
import MaterialNoteBox from '../components/MaterialNoteBox.vue'
import type { ProofreadIssue } from '../stores/proofreadStore'
import { useExportSettingsStore } from '../stores/exportSettings'
import { textToDocJson } from '../utils/textToDocJson'


/** 自定义 Mark：让 ProseMirror 识别 diff 高亮 span（否则会静默剥离） */
const DiffHighlight = Mark.create({
  name: 'diffHighlight',
  parseHTML() {
    return [{ tag: 'span.diff-change-highlight' }]
  },
  renderHTML() {
    return ['span', { class: 'diff-change-highlight' }, 0]
  },
})

/**
 * 自定义 Mark：批注（comment）。
 *  - 仅挂 commentId（不含 text），text 存到 store 顶层的 comments 数组中
 *  - 不渲染到 HTML：避免复制粘贴泄漏 + 避免从外部粘贴回来的 span 被错误识别
 *  - inclusive: false 防止光标在 mark 边界时被"吸入"mark 内
 *  - spanning: true 允许跨多个 inline 节点（加粗/斜体内等场景）
 */
const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      commentId: {
        // 用空串作为 default，避免 null 时 ProseMirror 跳过 wrapper
        default: '',
        // 从 HTML 反序列化时跳过（避免外部复制粘贴泄漏）
        parseHTML: () => '',
        // 渲染时把真实 id 写回 data-comment-id（仅供视图层 hover 定位）
        renderHTML: (attrs) => ({ 'data-comment-id': attrs.commentId ?? '' }),
      },
    }
  },

  parseHTML() {
    // 不解析外部 HTML 里的 comment span
    return []
  },

  renderHTML({ HTMLAttributes }) {
    // class 强制为 comment-mark，确保 CSS 选择器命中
    return ['span', { ...HTMLAttributes, class: 'comment-mark' }, 0]
  },

  addCommands(): any {
    return {
      setComment: (commentId: string) => ({ commands }: { commands: any }) =>
        commands.setMark(this.name, { commentId }),
      unsetComment: (commentId?: string) => ({ state, dispatch }: any) => {
        // 默认：移除选区内所有 comment mark
        // 指定 commentId：仅移除该 id（用于 deleteComment 流程）
        const markType = state.schema.marks[this.name]
        if (!markType) return false
        if (commentId) {
          // 遍历整个 doc，移除所有 attr.commentId === commentId 的 mark
          const tr2 = state.tr
          state.doc.descendants((node: any, pos: number) => {
            node.marks.forEach((m: any) => {
              if (m.type === markType && m.attrs.commentId === commentId) {
                tr2.removeMark(pos, pos + node.nodeSize, markType)
              }
            })
          })
          if (tr2.docChanged && dispatch) dispatch(tr2)
          return tr2.docChanged
        }
        return false
      },
    }
  },
})

/**
 * 角标 [n] 渲染插件：
 *  - 在每段带 comment mark 的文字末尾追加 sup 角标
 *  - 角标文本从 commentMap（id -> order）动态查得
 *  - 角标装饰不写回 doc JSON
 *  - 由 RichEditor 在 store.comments 变化时通过 meta 触发重建
 */
import type { EditorState } from 'prosemirror-state'

const commentBadgePluginKey = new PluginKey('commentBadge')

interface CommentBadgeMeta {
  /** commentId -> { order, orphan } */
  map: Map<string, { order: number; orphan: boolean }>
}

/** 构造装饰：根据当前 doc + commentMap 在每个 comment mark 范围末尾追加 sup 角标 */
function buildCommentDecorations(
  state: EditorState,
  map: Map<string, { order: number; orphan: boolean }>,
): Decoration[] {
  const decos: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.marks) return
    for (const mark of node.marks) {
      if (mark.type.name !== 'comment') continue
      const id = mark.attrs?.commentId
      if (!id) continue
      const meta = map.get(id)
      if (!meta || meta.orphan) continue
      const endPos = pos + node.nodeSize
      decos.push(
        Decoration.widget(
          endPos,
          () => {
            const el = document.createElement('sup')
            el.className = 'comment-badge'
            el.textContent = `[${meta.order}]`
            el.setAttribute('data-comment-id', id)
            el.contentEditable = 'false'
            return el
          },
          { side: 1, key: `comment-badge-${id}-${endPos}` },
        ),
      )
    }
  })
  return decos
}

/**
 * 角标渲染 Extension：在 addProseMirrorPlugins 中注入 ProseMirror 插件。
 * 插件内部持有最新 comment map，comments 变化（meta）或 doc 变化（docChanged，如切换文档）
 * 都用同一份 map 自动重建角标，无需外部在每个 setContent 后手动补 dispatch。
 */
const CommentBadgeExt = Extension.create({
  name: 'commentBadge',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: commentBadgePluginKey,
        state: {
          init: () => {
            // 初始 map 为空，由 RichEditor 首次 dispatch 注入
            return { decos: DecorationSet.empty, map: new Map<string, { order: number; orphan: boolean }>() }
          },
          apply(tr, old, _oldS, newState) {
            const meta = tr.getMeta(commentBadgePluginKey) as CommentBadgeMeta | undefined
            if (meta) {
              // comments 变化：更新持有的 map，并用它重建
              return {
                decos: DecorationSet.create(newState.doc, buildCommentDecorations(newState, meta.map)),
                map: meta.map,
              }
            }
            if (tr.docChanged && old.map.size > 0) {
              // doc 被替换（切换文档 / 版本回放等）：用已持有的最新 map 自动重建
              return {
                decos: DecorationSet.create(newState.doc, buildCommentDecorations(newState, old.map)),
                map: old.map,
              }
            }
            return old
          },
        },
        props: {
          decorations(state) {
            return commentBadgePluginKey.getState(state)?.decos ?? DecorationSet.empty
          },
        },
      }),
    ]
  },
})

/** 段落级行间距 + 缩进属性 */
const ParagraphExt = Extension.create({
  name: 'paragraphExt',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: el => el.style.lineHeight || null,
          renderHTML: attrs => {
            if (!attrs.lineHeight) return {}
            return { style: `line-height: ${attrs.lineHeight}` }
          },
        },
        textIndent: {
          default: null,
          parseHTML: el => el.style.textIndent || null,
          renderHTML: attrs => {
            if (!attrs.textIndent) return {}
            return { style: `text-indent: ${attrs.textIndent}` }
          },
        },
      },
    }]
  },
  addCommands() {
    return {
      setLineHeight: (value: string | null) => ({ chain }: { chain: any }) => {
        return chain().updateAttributes('paragraph', { lineHeight: value }).updateAttributes('heading', { lineHeight: value }).run()
      },
      setTextIndent: (value: number) => ({ chain }: { chain: any }) => {
        const v = value > 0 ? `${value}em` : null
        return chain()
          .updateAttributes('paragraph', { textIndent: v })
          .updateAttributes('heading', { textIndent: v })
          .run()
      },
    }
  },
})

/** 自定义 FontSize 扩展（选区级别字号，@tiptap/extension-font-size 在 v3 暂无稳定版） */
const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] }
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types as string[],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: el => {
            const raw = el.style.fontSize
            if (!raw) return null
            // 兼容旧静态 "16pt" 和新 calc 格式 "calc(16pt * var(--apz, 1))"
            const m = raw.match(/([\d.]+)\s*pt/)
            return m ? m[1] + 'pt' : null
          },
          renderHTML: attrs => {
            if (!attrs.fontSize) return {}
            // 参与页面缩放联动：calc(Xpt * var(--apz, 1))，默认 1 保证外部粘贴不炸
            return { style: `font-size: calc(${attrs.fontSize} * var(--apz, 1))` }
          },
        },
      },
    }]
  },
  addCommands() {
    return {
      setFontSize: (size: string) => ({ chain }: { chain: any }) => {
        return chain().setMark('textStyle', { fontSize: size }).run()
      },
      unsetFontSize: () => ({ chain }: { chain: any }) => {
        return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run()
      },
    }
  },
})

/** 自定义 Image 扩展：
 *  - src：当前会话可显示的 asset URL（convertFileSrc）
 *  - localPath：持久化本地路径（导出 Word 时读取）
 *  策略：插入/粘贴时存双属性，渲染用 src，
 *  加载时从 localPath 重新生成 src。 */
const LocalImage = ImageExt.extend({
  name: 'image',
  addAttributes() {
    // ★ 必须继承父类属性（src/alt/title/width/height），
    //   否则 TipTap 不会自动合并，src 会被当作未知属性丢弃
    return {
      ...(this.parent?.() || {}),
      /** 持久化本地路径，用于重启恢复和 Word 导出 */
      localPath: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-local-path') || null,
        renderHTML: (attrs: Record<string, any>) => {
          if (!attrs.localPath) return {}
          return { 'data-local-path': attrs.localPath }
        },
      },
    }
  },
})

const props = defineProps<{
  modelValue: any // ProseMirror JSON 文档模型 或 素材纯文本字符串
  readonly?: boolean
  editMode?: 'document' | 'material'
  materialId?: string
  /** 素材卡片标题（单素材=来源/标题，标签视图=标签名） */
  materialTitle?: string
  /** 素材卡片来源链接（仅单素材视图有） */
  materialSource?: string
  /** 当前是否处于某个真实标签上下文中（用于决定显示「从此标签移除」） */
  inTag?: boolean
  /** true=卡片自带滚动容器（单素材视图）；false=卡片内嵌到外部列表，由父级滚动（标签多卡片视图） */
  materialScroll?: boolean
  /** 素材卡片正文使用的字体（CSS font-family 值），不传则用默认 */
  materialFontFamily?: string
  /** 素材卡片正文字号（CSS 长度，如 '16px'），不传则用默认 */
  materialFontSize?: string
  /** 素材收藏时间（已格式化的字符串），显示在来源链接后 */
  materialTime?: string
  autoShowOutline?: boolean
  /** 外部搜索词：打开文档/素材后自动高亮并跳转到首个命中位置 */
  highlightQuery?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: any] // ProseMirror JSON 或 纯文本字符串
  'clip-material': [text: string]
  'insert-to-chat': [text: string]
  'delete-material': [selectionStart: string | number]
  'remove-from-tag': [selectionStart: string | number]
  'open-browser': [url: string]
  'toggle-fullscreen': []
  'selection-change': [selectedLength: number]
  'material-add-to-note': [text: string]
  'material-append-to-doc': [payload: { docId: string; text: string }]
}>()

const docStore = useDocumentStore()
const materialStore = useMaterialStore()
const noteBoxRef = ref<InstanceType<typeof MaterialNoteBox> | null>(null)
/** 碎念所属素材 id：标签视图下由父级按卡片传入 props.materialId；单素材视图回退到全局选中 id */
const noteMaterialId = computed(() => props.materialId || materialStore.currentMaterialId || '')
/** 💭 碎念按钮只负责让输入框出现（碎念区本身默认就在卡片内可见） */
function openNoteInput() {
  noteBoxRef.value?.openInput()
}
const candidateStore = useCandidateStore()
const compareStore = useCompareStore()
const proofreadStore = useProofreadStore()
const exportSettingsStore = useExportSettingsStore()

// ── 排版设置联动：字号与行间距 ──
const es = () => exportSettingsStore.settings

/** 正文基准字号 (pt) */
const bodyFontSizePt = computed(() => es().sizeBody)
/** 各标题字号 (pt) */
const h1FontSizePt = computed(() => es().sizeH1)
const h2FontSizePt = computed(() => es().sizeH2)
const h3FontSizePt = computed(() => es().sizeH3)
const h4FontSizePt = computed(() => es().sizeH4)

/** 字体家族（各样式独立，来自排版设置） */
const bodyFontFamily = computed(() => es().fontBody)
const h1FontFamily = computed(() => es().fontH1)
const h2FontFamily = computed(() => es().fontH2)
const h3FontFamily = computed(() => es().fontH3)
const h4FontFamily = computed(() => es().fontH4)

/** 基准行高 = lineSpacingPt / sizeBody（CSS 倍数） */
const bodyLineHeight = computed(() => {
  const sp = es().lineSpacingPt
  const sz = es().sizeBody
  return +(sp / sz).toFixed(2)
})
const h1LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH1).toFixed(2))
const h2LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH2).toFixed(2))
const h3LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH3).toFixed(2))
const h4LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH4).toFixed(2))

/** 标题加粗开关（来自排版设置） */
const h1FontWeight = computed(() => es().boldH1 ? 700 : 400)
const h2FontWeight = computed(() => es().boldH2 ? 700 : 400)
const h3FontWeight = computed(() => es().boldH3 ? 700 : 400)
const h4FontWeight = computed(() => es().boldH4 ? 700 : 400)

/** 工具栏样式下拉菜单预览的字号缩放（22pt 在下拉里过大，按比例缩放） */
const TOOLBAR_PREVIEW_SCALE = 0.7
/** 工具栏下拉中"正文"预览的样式（继承排版设置中的字体/字号/加粗） */
const previewBodyStyle = computed(() => ({
  fontFamily: bodyFontFamily.value,
  fontSize: `${es().sizeBody * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: es().boldBody ? 700 : 400,
}))
/** 工具栏下拉中"标题 1"预览的样式 */
const previewH1Style = computed(() => ({
  fontFamily: h1FontFamily.value,
  fontSize: `${es().sizeH1 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h1FontWeight.value,
}))
/** 工具栏下拉中"标题 2"预览的样式 */
const previewH2Style = computed(() => ({
  fontFamily: h2FontFamily.value,
  fontSize: `${es().sizeH2 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h2FontWeight.value,
}))
/** 工具栏下拉中"标题 3"预览的样式 */
const previewH3Style = computed(() => ({
  fontFamily: h3FontFamily.value,
  fontSize: `${es().sizeH3 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h3FontWeight.value,
}))
/** 工具栏下拉中"标题 4"预览的样式 */
const previewH4Style = computed(() => ({
  fontFamily: h4FontFamily.value,
  fontSize: `${es().sizeH4 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h4FontWeight.value,
}))

// ── 主题（接入全局 theme store）──
import { useTheme } from '../stores/theme'
const { isDark } = useTheme()
const isLight = computed(() => !isDark.value)

// ── 字体（与排版设置对齐：各样式独立字体） ──
const fontOptions = [
  '方正小标宋简体', '方正黑体简体', '方正楷体简体', '方正仿宋简体',
  '宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'Times New Roman',
]
/** 当前光标/选区处的字体（优先 inline mark，其次块级样式，最后排版设置） */
const fontFamily = computed(() => {
  void editorStateTick.value // 依赖手动触发器，确保 ProseMirror 状态变更时重新求值
  const ed = editor.value
  if (!ed) return es().fontBody
  // 1. 选区级别 inline 字体（textStyle mark）
  const textAttrs = ed.getAttributes('textStyle')
  if (textAttrs.fontFamily) return textAttrs.fontFamily
  // 2. 块级样式字体（光标所在标题/正文）
  if (ed.isActive('heading', { level: 1 })) return es().fontH1
  if (ed.isActive('heading', { level: 2 })) return es().fontH2
  if (ed.isActive('heading', { level: 3 })) return es().fontH3
  if (ed.isActive('heading', { level: 4 })) return es().fontH4
  return es().fontBody
})
function setFontFamily(f: string) {
  editor.value?.chain().focus().setFontFamily(f).run()
}
/** 工具栏字体按钮显示用的标签：当前字体若不在可选列表内（如粘贴网页带进的系统字体栈），
 *  不再把原始字体栈当文本平铺，而是显示占位，避免窄按钮内换行成"乱码"。 */
const fontFamilyLabel = computed(() => {
  const raw = fontFamily.value
  if (!raw) return '字体'
  const trimmed = raw.trim()
  if (fontOptions.includes(trimmed)) return trimmed
  const matched = fontOptions.find((f) => trimmed.includes(f))
  return matched ?? '其他字体'
})

// ── 字号（中文公文号数制，选区级别） ──
// ★ 对齐导出设置面板 fontSizeOptions，统一使用标准 pt 值
interface FontSizeEntry { label: string; px: number }
const fontSizeMap: FontSizeEntry[] = [
  { label: '一号', px: 26 },
  { label: '小一', px: 24 },
  { label: '二号', px: 22 },
  { label: '小二', px: 18 },
  { label: '三号', px: 16 },
  { label: '小三', px: 15 },
  { label: '四号', px: 14 },
  { label: '小四', px: 12 },
  { label: '五号', px: 10.5 },
  { label: '小五', px: 9 },
]

/** 获取当前上下文的字号 pt 值（优先 textStyle mark，其次标题块级，最后正文字号） */
function getContextFontSizePt(): number {
  const ed = editor.value
  if (!ed) return es().sizeBody
  // 1. textStyle mark 中的 fontSize
  const attrs = ed.getAttributes('textStyle')
  if (attrs.fontSize) {
    const px = parseFloat(attrs.fontSize)
    if (px) return px
  }
  // 2. 标题块级 fallback（与 fontFamily 逻辑一致）
  if (ed.isActive('heading', { level: 1 })) return es().sizeH1
  if (ed.isActive('heading', { level: 2 })) return es().sizeH2
  if (ed.isActive('heading', { level: 3 })) return es().sizeH3
  if (ed.isActive('heading', { level: 4 })) return es().sizeH4
  // 3. 正文基准
  return es().sizeBody
}

/** pt 值 → 最近的中文号数名称 */
function ptToFontSizeLabel(pt: number): string {
  if (!pt) return '三号'
  let best = fontSizeMap[4] // 默认三号
  let minDiff = Infinity
  for (const f of fontSizeMap) {
    const diff = Math.abs(f.px - pt)
    if (diff < minDiff) { minDiff = diff; best = f }
  }
  return best.label
}

/** 当前光标/选区处的字号名称（用于工具栏显示） */
const currentFontSizeLabel = computed(() => {
  void editorStateTick.value // 依赖手动触发器，确保 ProseMirror 状态变更时重新求值
  return ptToFontSizeLabel(getContextFontSizePt())
})

function setFontSize(label: string) {
  const entry = fontSizeMap.find(f => f.label === label)
  if (!entry) return
  editor.value?.chain().focus().setFontSize(entry.px + 'pt').run()
}

/** 页面缩放：放大 5%（Ctrl+滚轮 / 工具栏按钮共用步长） */
function zoomIn() {
  pageZoom.value = Math.min(2.0, +(pageZoom.value + 0.05).toFixed(2))
}

/** 页面缩放：缩小 5% */
function zoomOut() {
  pageZoom.value = Math.max(0.5, +(pageZoom.value - 0.05).toFixed(2))
}

// ── 页面缩放（Ctrl+滚轮） ──
const pageZoom = ref(1.0)
const zoomPercent = computed(() => Math.round(pageZoom.value * 100))

// ── 大纲面板 ──
const showOutline = ref(false)
const outlineWidth = ref(200)
const MIN_OUTLINE_WIDTH = 200
const MAX_OUTLINE_WIDTH = 500

interface HeadingItem { level: number; text: string; pos: number }
const headings = ref<HeadingItem[]>([])

const isResizingOutline = ref(false)

function startResizeOutline(e: MouseEvent) {
  e.preventDefault()
  isResizingOutline.value = true
  const startX = e.clientX
  const startWidth = outlineWidth.value

  const onMouseMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    outlineWidth.value = Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, startWidth + delta))
  }

  const onMouseUp = () => {
    cleanupResize()
  }
  const cleanupResize = () => {
    isResizingOutline.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    window.removeEventListener('blur', cleanupResize)
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  window.addEventListener('blur', cleanupResize)
}

function extractHeadings(ed: any) {
  if (!ed) { headings.value = []; return }
  const result: HeadingItem[] = []
  ed.state.doc.descendants((node: { type: { name: string }; attrs: { level: number }; textContent: string }, pos: number) => {
    if (node.type.name === 'heading') {
      result.push({ level: node.attrs.level, text: node.textContent, pos })
    }
  })
  headings.value = result
}

function scrollToHeading(pos: number) {
  const ed = editor.value
  if (!ed) return
  // ★ 用 +1 让 ProseMirror 视作"有变化"，避免相同位置重复点击时 ProseMirror 不更新视图
  const newPos = ed.state.selection.from === pos ? pos + 1 : pos
  ed.chain().focus().setTextSelection(newPos).run()
  // 滚动到该 heading 节点对应的 DOM 元素（取最近的 heading 祖先）
  nextTick(() => {
    try {
      const dom = ed.view.nodeDOM(pos) as HTMLElement | null
      // 向上找最近的 heading 元素（domAtPos 可能落到文本子节点上）
      const headingEl = (dom?.closest?.('h1, h2, h3, h4') as HTMLElement | null) || dom
      headingEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch { /* DOM 已卸载 */ }
  })
}

// ── 表格格选面板 ──
const tablePickerOpen = ref(false)
const tablePickerRows = ref(4)
const tablePickerCols = ref(4)
const maxTableRows = 10
const maxTableCols = 10

function openTablePicker() {
  tablePickerOpen.value = true
  tablePickerRows.value = 4
  tablePickerCols.value = 4
}
function closeTablePicker() {
  tablePickerOpen.value = false
}
function insertTableAt(r: number, c: number) {
  focus()
  editor.value?.chain().insertTable({ rows: r, cols: c, withHeaderRow: true }).run()
  tablePickerOpen.value = false
}

// ── 表格操作状态 ──
const isInTable = computed(() => editor.value?.isActive('table') ?? false)

/** 是否为 CellSelection（Ctrl/Cmd + 点击 选中了一个或多个单元格） */
const isCellSelection = computed(() => {
  const ed = editor.value
  if (!ed) return false
  return ed.state.selection instanceof CellSelection
})

/** 是否可合并：选中了至少两个不同单元格 */
const canMergeCells = computed(() => {
  const ed = editor.value
  if (!ed) return false
  const sel = ed.state.selection
  if (!(sel instanceof CellSelection)) return false
  return sel.$anchorCell.pos !== sel.$headCell.pos
})

/** 是否可拆分：当前单元格 colspan > 1 或 rowspan > 1 */
const canSplitCell = computed(() => {
  const ed = editor.value
  if (!ed) return false
  const $pos = ed.state.doc.resolve(ed.state.selection.from)
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d)
    if (node && (node.type.name === 'tableCell' || node.type.name === 'tableHeader')) {
      return node.attrs.colspan > 1 || node.attrs.rowspan > 1
    }
  }
  return false
})

// ── 表格操作命令 ──
function execAddRowBefore() { focus(); editor.value?.chain().addRowBefore().run() }
function execAddRowAfter() { focus(); editor.value?.chain().addRowAfter().run() }
function execAddColumnBefore() { focus(); editor.value?.chain().addColumnBefore().run() }
function execAddColumnAfter() { focus(); editor.value?.chain().addColumnAfter().run() }
function execDeleteRow() { focus(); editor.value?.chain().deleteRow().run() }
function execDeleteColumn() { focus(); editor.value?.chain().deleteColumn().run() }
function execDeleteTable() { focus(); editor.value?.chain().deleteTable().run() }
function execMergeCells() { focus(); if (canMergeCells.value) editor.value?.chain().mergeCells().run() }
function execSplitCell() { focus(); if (canSplitCell.value) editor.value?.chain().splitCell().run() }
function execToggleHeaderRow() { focus(); editor.value?.chain().toggleHeaderRow().run() }

// ── 搜索高亮 ProseMirror Plugin ──
const searchPluginKey = new PluginKey('searchHighlight')

const SearchHighlightExt = Extension.create({
  name: 'searchHighlightExt',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchPluginKey,
      state: {
        init() { return DecorationSet.empty },
        apply(tr, old) {
          const meta = tr.getMeta(searchPluginKey)
          if (meta !== undefined) return meta
          if (tr.docChanged) return old.map(tr.mapping, tr.doc)
          return old
        },
      },
      props: {
        decorations(state) { return this.getState(state) },
      },
    })]
  },
})

// ── 校对波浪线 ProseMirror Plugin ──
const proofreadPluginKey = new PluginKey('proofreadHighlight')

const ProofreadExt = Extension.create({
  name: 'proofreadHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: proofreadPluginKey,
      state: {
        init() { return DecorationSet.empty },
        apply(tr, old) {
          const meta = tr.getMeta(proofreadPluginKey)
          if (meta !== undefined) return meta
          if (tr.docChanged) return old.map(tr.mapping, tr.doc)
          return old
        },
      },
      props: {
        decorations(state) { return this.getState(state) },
      },
    })]
  },
})

// ── 查找替换 ──
/** 通用防抖，用于搜索等高频触发操作 */
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, ms)
  }) as T & { cancel: () => void }
  debounced.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }
  return debounced
}
const searchOpen = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const replaceQuery = ref('')
const searchCount = ref(0)
const searchIdx = ref(0)
const caseSensitive = ref(false)
const debouncedSearch = debounce(() => doSearch(), 200)
// 查找匹配结果（<script setup> 作用域内，每个组件实例独立，不存在多实例共享问题）
let _searchMatches: { from: number; to: number }[] = []

function applySearchDecorations() {
  const ed = editor.value
  if (!ed) return
  const decos = _searchMatches.length > 0
    ? DecorationSet.create(ed.state.doc, _searchMatches.map(r =>
        Decoration.inline(r.from, r.to, { class: 'search-highlight' })))
    : DecorationSet.empty
  ed.view.dispatch(ed.state.tr.setMeta(searchPluginKey, decos))
}

function printDocument() {
  // 打印前滚动到顶部，确保完整渲染
  const ce = document.querySelector('.rich-content')
  if (ce) ce.scrollTop = 0
  // 延迟打印让 DOM 更新生效
  requestAnimationFrame(() => window.print())
}

// ── 素材卡片头部操作 ──
/** 复制：有选区复制选区，否则复制整篇素材纯文本 */
function onCardCopy() {
  const ed = editor.value
  if (!ed) return
  const { from, to } = ed.state.selection
  const text = from !== to ? ed.state.doc.textBetween(from, to, '\n') : ed.getText()
  if (text) navigator.clipboard.writeText(text).catch(() => {})
}
/** 从素材库删除（优先按 known materialId 定位，兜底用选区位置） */
function onCardDelete() {
  emit('delete-material', props.materialId ?? editor.value?.state.selection.from ?? 0)
}
/** 从当前标签移除（优先按 known materialId 定位，兜底用选区位置） */
function onCardRemoveFromTag() {
  emit('remove-from-tag', props.materialId ?? editor.value?.state.selection.from ?? 0)
}
function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    setTimeout(() => searchInputRef.value?.focus(), 50)
  } else {
    clearSearchHighlights()
  }
}
function doSearch() {
  clearSearchHighlights()
  const ed = editor.value
  if (!ed || !searchQuery.value) { searchCount.value = 0; searchIdx.value = 0; return }
  const q = caseSensitive.value ? searchQuery.value : searchQuery.value.toLowerCase()
  const results: { from: number; to: number }[] = []
  // ★ 遍历所有文本叶子节点，精确计算 ProseMirror 文档位置
  ed.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const text = caseSensitive.value ? node.text : node.text.toLowerCase()
    let offset = 0
    while (offset < text.length) {
      const found = text.indexOf(q, offset)
      if (found === -1) break
      results.push({ from: pos + found, to: pos + found + q.length })
      offset = found + q.length
    }
    return true
  })
  _searchMatches = results
  searchCount.value = results.length
  searchIdx.value = results.length > 0 ? 1 : 0
  applySearchDecorations()
  if (results.length > 0) {
    goToResult(0)
  }
}
function doReplace() {
  const ed = editor.value
  if (!ed || !searchQuery.value || _searchMatches.length === 0) return
  const idx = searchIdx.value - 1
  if (idx < 0 || idx >= _searchMatches.length) return
  const { from, to } = _searchMatches[idx]
  if (replaceQuery.value) {
    ed.chain().focus().setTextSelection({ from, to }).insertContent(replaceQuery.value).run()
  } else {
    // 替换为空：直接删除选中文本
    ed.chain().focus().setTextSelection({ from, to }).deleteSelection().run()
  }
  // 替换后重新搜索
  setTimeout(() => doSearch(), 50)
}
function doReplaceAll() {
  const ed = editor.value
  if (!ed || !searchQuery.value) return
  const allResults = [..._searchMatches]
  // 从后往前替换，避免位置偏移
  for (let i = allResults.length - 1; i >= 0; i--) {
    const { from, to } = allResults[i]
    if (replaceQuery.value) {
      ed.chain().setTextSelection({ from, to }).insertContent(replaceQuery.value).run()
    } else {
      // 替换为空：直接删除选中文本
      ed.chain().setTextSelection({ from, to }).deleteSelection().run()
    }
  }
  // 替换完成后重新搜索，更新高亮和计数
  setTimeout(() => doSearch(), 50)
}
function goToResult(idx: number) {
  const ed = editor.value
  if (!ed || _searchMatches.length === 0) return
  const i = Math.max(0, Math.min(idx, _searchMatches.length - 1))
  searchIdx.value = i + 1
  const { from, to } = _searchMatches[i]
  ed.chain().focus().setTextSelection({ from, to }).run()
  // 滚动到视图
  const dom = ed.view.domAtPos(from)
  if (dom.node) {
    const el = (dom.node.nodeType === 3 ? dom.node.parentElement : dom.node) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
function prevResult() {
  const newIdx = searchIdx.value <= 1 ? _searchMatches.length - 1 : searchIdx.value - 2
  goToResult(newIdx)
}
function nextResult() {
  goToResult(searchIdx.value < _searchMatches.length ? searchIdx.value : 0)
}
function clearSearchHighlights() {
  _searchMatches = []
  const ed = editor.value
  if (ed) {
    ed.view.dispatch(ed.state.tr.setMeta(searchPluginKey, DecorationSet.empty))
  }
  searchCount.value = 0
  searchIdx.value = 0
}




// ── 颜色（全部 computed，模板中只用 :style，杜绝 # 解析 bug） ──
// 深色模式设计原则：工具栏为暗色"边框"框住内容区；内容区作为"画布"最亮；
// 下拉面板介于两者之间，体现悬浮感；文字对比度充足，质感通透。
const tbBg = computed(() => isLight.value ? '#f8f9fa' : '#14151d')
const tbBorder = computed(() => isLight.value ? '#d9d9d9' : '#232533')
const tbSep = computed(() => isLight.value ? '#d9d9d9' : '#232533')
const btnText = computed(() => isLight.value ? '#4a4a5a' : '#888da0')
const btnHoverBg = computed(() => isLight.value ? '#e9ecef' : '#1c1e2c')
const btnActiveBg = computed(() => isLight.value ? '#d0d5db' : 'rgba(138,173,244,0.18)')
const btnActiveText = computed(() => isLight.value ? '#1a56db' : '#89b4fa')
const ddBg = computed(() => isLight.value ? '#ffffff' : '#1a1c29')
const ddBorder = computed(() => isLight.value ? '#d9d9d9' : '#292c3c')
const ddHoverBg = computed(() => isLight.value ? '#f3f4f6' : '#222537')
const contentBg = computed(() => isLight.value ? '#ffffff' : '#1d2032')
const contentText = computed(() => isLight.value ? '#1a1a1a' : '#cdd6f4')

// ── 素材卡片主题色 ──
const cardAccent = computed(() => isLight.value ? '#6366f1' : '#89b4fa')
const cardTitleBg = computed(() => isLight.value ? 'linear-gradient(135deg, rgba(99,102,241,0.07) 0%, rgba(99,102,241,0.02) 100%)' : 'linear-gradient(135deg, rgba(137,180,250,0.08) 0%, rgba(137,180,250,0.02) 100%)')
const cardMetaColor = computed(() => isLight.value ? '#9ca3af' : '#696e88')
const cardDivider = computed(() => isLight.value ? 'linear-gradient(90deg, transparent 0%, rgba(209,213,219,0.5) 30%, rgba(209,213,219,0.7) 50%, rgba(209,213,219,0.5) 70%, transparent 100%)' : 'linear-gradient(90deg, transparent 0%, rgba(41,44,60,0.5) 30%, rgba(41,44,60,0.7) 50%, rgba(41,44,60,0.5) 70%, transparent 100%)')
const metaBg = computed(() => isLight.value ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.06)')
const dropdownItemColor = computed(() => isLight.value ? '#1f2937' : '#bac2de')

// ── 右键菜单状态 ──
const ctxMenuShow = ref(false)
const ctxMenuX = ref(0)
const ctxMenuY = ref(0)
const ctxMenuSelText = ref('')
const ctxMenuSelFrom = ref(0)
const ctxMenuSelTo = ref(0)

/** 智能四向翻转定位：菜单永不出界 */
function editorSmartMenuPos(cursorX: number, cursorY: number, menuW: number, menuH: number) {
  const MARGIN = 8
  const spaceRight  = window.innerWidth - cursorX - MARGIN
  const spaceBottom = window.innerHeight - cursorY - MARGIN
  const x = spaceRight >= menuW
    ? cursorX
    : Math.max(MARGIN, cursorX - menuW)
  const y = spaceBottom >= menuH
    ? cursorY
    : Math.max(MARGIN, cursorY - menuH)
  return { x, y }
}

/** 居中定位版：anchor 为浮层水平中心，浮层宽度 menuW，自动避左右 + 上下 */
function editorSmartMenuPosCenter(
  anchorX: number, anchorYBottom: number, menuW: number, menuH: number,
) {
  const MARGIN = 8
  // 水平：让浮层中心对齐 anchorX；左溢出贴 MARGIN，右溢出贴 innerWidth - menuW - MARGIN
  let left = anchorX - menuW / 2
  if (left < MARGIN) left = MARGIN
  if (left + menuW + MARGIN > window.innerWidth) left = window.innerWidth - menuW - MARGIN
  // 垂直：默认放在 anchor 下方 6px；下方空间不够则翻到上方
  let top = anchorYBottom + 6
  if (top + menuH + MARGIN > window.innerHeight) {
    top = anchorYBottom - menuH - 6 - 32 // 32 = 工具栏估计高度补偿
    if (top < MARGIN) top = MARGIN
  }
  return { top, left }
}

function closeCtxMenu() { ctxMenuShow.value = false }

async function execCtxMenuCut() {
  const ed = editor.value
  if (!ed || !ctxMenuSelText.value) return
  try { await navigator.clipboard.writeText(ctxMenuSelText.value) }
  catch { /* clipboard API 不可用，降级为空操作（避免错误删除文字） */ }
  ed.chain().deleteSelection().run()
  ed.commands.focus()
  closeCtxMenu()
}
async function execCtxMenuCopy() {
  const ed = editor.value
  if (!ed || !ctxMenuSelText.value) return
  try { await navigator.clipboard.writeText(ctxMenuSelText.value) }
  catch { /* clipboard API 不可用 */ }
  ed.commands.focus()
  closeCtxMenu()
}
async function execCtxMenuPaste() {
  const ed = editor.value
  if (!ed) return
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      // ★ 使用 textToDocJson 解析多段落文本为 ProseMirror JSON 节点，
      //    避免 insertContent("段落A\n段落B") 产生 hardBreak 内联节点，
      //    导致后续 Enter 拆分段落时光标位置映射偏移。
      const doc = textToDocJson(text)
      if (doc.content && doc.content.length > 0) {
        // 单段落纯文本：只插内联内容，避免把整个 paragraph 块插入光标处
        // 导致当前段落被切开、头尾各换行；同时该路径不含 \n/hardBreak，
        // 不会重现当初的「光标跳脱」位移。
        if (doc.content.length === 1 && doc.content[0].type === 'paragraph') {
          const inline = doc.content[0].content || []
          if (inline.length > 0) ed.chain().focus().insertContent(inline).run()
        } else {
          // 多段落 / 标题 / 列表：保持块级插入（本就该分段）
          ed.chain().focus().insertContent(doc.content).run()
        }
      }
    }
  } catch { /* 剪贴板读取失败 */ }
  ed.commands.focus()
  closeCtxMenu()
}
function execCtxMenuClip() {
  if (ctxMenuSelText.value) {
    materialStore.openClipDialog(ctxMenuSelText.value)
    emit('clip-material', ctxMenuSelText.value)
  }
  closeCtxMenu()
}
function execCtxMenuAddToChat() {
  docStore.injectedChatText = ctxMenuSelText.value
  docStore.sidebarTab = 'chat'
  closeCtxMenu()
}
function execCtxMenuAddComment() {
  closeCtxMenu()
  // 延迟一帧让菜单关闭动画完成
  nextTick(() => execComment())
}
function execCtxMenuAddToCandidate() {
  if (!ctxMenuSelText.value) return
  const isDoc = !props.editMode || props.editMode === 'document'
  candidateStore.add({
    text: ctxMenuSelText.value,
    sourceType: isDoc ? 'document' : 'material',
    sourceId: isDoc ? docStore.currentDocId : (materialStore.currentMaterialId || ''),
    sourceTitle: isDoc ? docStore.currentTitle : (materialStore.currentMaterial?.title || ''),
  })
  closeCtxMenu()
}
function execCtxMenuAddToCompare() {
  if (!ctxMenuSelText.value) return
  compareStore.addEntry(ctxMenuSelText.value, '编辑器选中')
  closeCtxMenu()
}
function execCtxMenuInsertToChat() {
  if (ctxMenuSelText.value) {
    emit('insert-to-chat', ctxMenuSelText.value)
  }
  closeCtxMenu()
}
function execCtxMenuDeleteMaterial() {
  // 使用当前编辑器选区位置，避免使用可能已失效的缓存位置
  const ed = editor.value
  const pos = ed ? ed.state.selection.from : ctxMenuSelFrom.value
  emit('delete-material', pos)
  closeCtxMenu()
}
function execCtxMenuRemoveFromTag() {
  const ed = editor.value
  const pos = ed ? ed.state.selection.from : ctxMenuSelFrom.value
  emit('remove-from-tag', pos)
  closeCtxMenu()
}

// ── 文字颜色 ──
const colorPalette = ['#000000','#444444','#888888','#cccccc','#ff0000','#ff6600','#ffcc00','#00cc00','#0066ff','#6600cc']
const colorPickerOpen = ref(false)
function toggleColorPicker() { closeAllPickers(); colorPickerOpen.value = !colorPickerOpen.value }
function setTextColor(color: string) {
  focus()
  editor.value?.chain().setColor(color).run()
  colorPickerOpen.value = false
}
const currentTextColor = computed(() => {
  void editorStateTick.value
  const attrs = editor.value?.getAttributes('textStyle')
  return attrs?.color || ''
})


// ── 工具栏下拉状态 ──
const headingDropdownOpen = ref(false)
const fontDropdownOpen = ref(false)
const fontSizeDropdownOpen = ref(false)

/** 手动响应式触发器：ProseMirror 内部状态（getAttributes/isActive）不受 Vue 追踪，
 *  每次 transaction 或 selection 变更时自增，强制相关 computed 重新求值。 */
const editorStateTick = ref(0)

// ── 批注：监听 store.comments 变化，刷新角标装饰 + 清理 ghost mark ──
Vue.watch(
  () => docStore.comments,
  (list) => {
    const ed = editor.value
    if (!ed) return
    // 1. 刷新装饰
    const map = new Map<string, { order: number; orphan: boolean }>()
    for (const c of list) map.set(c.id, { order: c.order, orphan: c.orphan })
    ed.view.dispatch(
      ed.state.tr.setMeta(commentBadgePluginKey, { map }),
    )
    // 2. 清理 ghost mark：doc 中引用了已不在 comments 的 id
    const ids = new Set(list.map((c) => c.id))
    const markType = ed.state.schema.marks.comment
    if (!markType) return
    // 不进 undo 栈：用户没主动删，这些是幽灵 mark 自动清理
    const tr = ed.state.tr.setMeta('addToHistory', false)
    let dirty = false
    ed.state.doc.descendants((node, pos) => {
      if (!node.marks) return
      for (const m of node.marks) {
        if (m.type === markType && m.attrs.commentId && !ids.has(m.attrs.commentId)) {
          tr.removeMark(pos, pos + node.nodeSize, markType)
          dirty = true
        }
      }
    })
    if (dirty) {
      syncing = true
      ed.view.dispatch(tr)
      syncing = false
      // 清理被 syncing 早退吞掉的回流：让 currentContent 更新，交给 1 秒防抖落库
      const json = ed.getJSON()
      const current = typeof props.modelValue === 'object' ? props.modelValue : null
      if (stableJSON(json) !== stableJSON(current)) {
        emit('update:modelValue', json)
      }
    }
  },
  { deep: true },
)

// ── 校对：波浪线装饰 + 重映射 + 编辑即删 ──
/** 校对按钮高亮：仅在流式进行中亮起，完成后恢复常态（面板打开不代表按钮激活） */
const proofreadActive = computed(() => proofreadStore.loading)

/** 根据当前 store.items 重建波浪线装饰（from/to 为绝对文档位置） */
function rebuildProofreadDecorations() {
  const ed = editor.value
  if (!ed) return
  const decos = proofreadStore.items.length > 0
    ? DecorationSet.create(
        ed.state.doc,
        proofreadStore.items.map((i) =>
          Decoration.inline(i.from, i.to, {
            class: 'proofread-underline',
            'data-proofread-id': i.id,
          }),
        ),
      )
    : DecorationSet.empty
  ed.view.dispatch(ed.state.tr.setMeta(proofreadPluginKey, decos))
}

/** items 变化即重建装饰（忽略/替换/清空调正词/重映射都会触发） */
Vue.watch(
  () => proofreadStore.items,
  () => rebuildProofreadDecorations(),
)

/** 工具栏触发：无选区→全文，有选区→选区 */
function runProofreadAction() {
  const ed = editor.value
  if (!ed) return
  const { from, to, empty } = ed.state.selection
  if (empty) {
    proofreadStore.runProofread(ed.state.doc)
  } else {
    proofreadStore.runProofread(ed.state.doc, from, to)
  }
}

// ── 校对 hover 浮层 ──
const proofreadTip = ref<{ show: boolean; x: number; y: number; issue: ProofreadIssue | null }>({
  show: false, x: 0, y: 0, issue: null,
})
let _pfTipTimer: ReturnType<typeof setTimeout> | null = null
function showProofreadTip(issue: ProofreadIssue, el: HTMLElement) {
  if (_pfTipTimer) clearTimeout(_pfTipTimer)
  const r = el.getBoundingClientRect()
  proofreadTip.value = { show: true, x: r.left, y: r.bottom + 6, issue }
}
function scheduleHideProofreadTip() {
  if (_pfTipTimer) clearTimeout(_pfTipTimer)
  _pfTipTimer = setTimeout(() => { proofreadTip.value.show = false }, 220)
}

function closeAllPickers() {
  headingDropdownOpen.value = false
  fontDropdownOpen.value = false
  fontSizeDropdownOpen.value = false
  colorPickerOpen.value = false
  symbolPanelOpen.value = false
}
function toggleHeadingDropdown() { closeAllPickers(); headingDropdownOpen.value = !headingDropdownOpen.value }
function toggleFontDropdown() { closeAllPickers(); fontDropdownOpen.value = !fontDropdownOpen.value }
function toggleFontSizeDropdown() { closeAllPickers(); fontSizeDropdownOpen.value = !fontSizeDropdownOpen.value }
function closeDropdowns() { closeAllPickers() }

// ── ProseMirror JSON 内容应用（原生格式，无 Markdown 转换）──

// ── 同步保护（核心：防止初始化竞态清空 content） ──
// syncDepth 计数器替换原 boolean syncing，防 async 嵌套调用竞态
let syncing = false   // 保留旧名供外部引用兼容
let syncDepth = 0
let initialized = false
/** IME 组合输入期间标记（compositionstart → compositionend），防止中途 emit 破坏输入法状态 */
let isComposing = false

/**
 * 稳定 JSON 序列化：递归排序对象 key，确保结构一致时字符串也一致。
 * 用于安全对比 ProseMirror JSON，避免属性排序差异导致误判。
 */
function stableJSON(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj)
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => stableJSON(item)).join(',') + ']'
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const pairs = keys.map(k => {
    const v = (obj as Record<string, unknown>)[k]
    // 跳过 null 值属性（ProseMirror 默认会省略，避免对比不一致）
    if (v === null) return null
    return JSON.stringify(k) + ':' + stableJSON(v)
  }).filter(Boolean)
  return '{' + pairs.join(',') + '}'
}

/** 将纯文本字符偏移映射为 ProseMirror 文档位置（1-based） */
function textOffsetToDocPos(ed: any, targetOffset: number): number {
  let accumulated = 0
  let result = 1
  ed.state.doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const len = (node.text || '').length
      if (accumulated <= targetOffset && accumulated + len >= targetOffset) {
        result = pos + (targetOffset - accumulated) + 1
        return false
      }
      accumulated += len
    }
    return true
  })
  return result
}

/** 将字节数组转为 data:image/...;base64,... URL */
async function bytesToDataUrl(bytes: Uint8Array | number[], ext: string): Promise<string> {
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }
  const mime = mimeMap[ext] || 'image/png'
  const blob = new Blob([new Uint8Array(bytes)], { type: mime })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** 预处理 ProseMirror JSON：为有 localPath 但 src 失效的图片重新生成 data URL */
async function prepareContent(json: any): Promise<any> {
  if (!json || typeof json !== 'object' || !json.content) return json
  const doc = JSON.parse(JSON.stringify(json)) // deep clone
  await recoverImageNodes(doc)
  return doc
}

async function recoverImageNodes(node: any) {
  if (node.type === 'image' && node.attrs?.localPath && typeof node.attrs.localPath === 'string') {
    const src = node.attrs.src
    if (!src || (typeof src === 'string' && (src.startsWith('blob:') || src.startsWith('asset:')))) {
      try {
        const bytes = await invoke<number[]>('read_image_file', { path: node.attrs.localPath })
        const ext = node.attrs.localPath.split('.').pop()?.toLowerCase() || 'png'
        node.attrs.src = await bytesToDataUrl(new Uint8Array(bytes), ext)
      } catch (e) {
        console.error('[prepareContent] 图片恢复失败:', node.attrs.localPath, e)
      }
    }
  }
  if (node.content && Array.isArray(node.content)) {
    for (const child of node.content) {
      await recoverImageNodes(child)
    }
  }
}




/** 将内容注入编辑器：支持 ProseMirror JSON 对象 或 纯文本字符串 */
async function applyContent(content: any) {
  const ed = editor.value
  if (!ed) return
  syncing = true        // 旧名兼容（已改用 syncDepth）
  syncDepth++
  try {
    if (content && typeof content === 'object' && content.type === 'doc') {
      // 预处理：恢复图片 data URL（从 localPath 重新生成）
      const prepared = await prepareContent(content)
      ed.commands.setContent(prepared)
    } else if (typeof content === 'string' && content) {
      // 纯文本（素材模式 / 向后兼容旧数据）→ 按双换行拆分为多个段落
      ed.commands.setContent(textToDocJson(content))
    } else {
      // 空内容
      ed.commands.setContent({ type: 'doc', content: [] })
    }
  } catch {
    ed.commands.setContent({ type: 'doc', content: [] })
  }
  syncing = false       // 旧名兼容（已改用 syncDepth，嵌套调用安全）
  syncDepth = Math.max(0, syncDepth - 1)
  extractHeadings(ed)
}

// ── 创建 TipTap 编辑器 ──
const editor = useEditor({
  content: props.modelValue || '',
  editable: !props.readonly,
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      bulletList: false,
      orderedList: false,
      listItem: false,
      link: { openOnClick: false, HTMLAttributes: { class: 'text-blue-500 dark:text-blue-400 underline' } },
    }),
    // 列表节点仅用于渲染（如教程手册），关闭输入规则，避免敲 `- `/`1. ` 自动转列表
    BulletList.extend({ addInputRules() { return [] } }),
    OrderedList.extend({ addInputRules() { return [] } }),
    ListItem,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    LocalImage.configure({ inline: false, allowBase64: false }),
    Placeholder.configure({ placeholder: '把这一页，交给灵感...' }),
    TextStyle,
    FontFamily,
    Color,
    Superscript,
    Subscript,
    ParagraphExt,
    FontSize,
    Typography,
    SearchHighlightExt,
    ProofreadExt,
    DiffHighlight,
    CommentMark,
    CommentBadgeExt,
  ],
  onCreate() {
    // 编辑已创建，异步恢复图片 data URL（初始内容已通过 content 选项注入）
    applyContent(props.modelValue).then(() => {
      initialized = true
    })
  },
  onUpdate({ transaction }) {
    editorStateTick.value++
    // ── 校对：文档变更后重映射位置，编辑命中错误区间则删除该项 ──
    if (transaction.docChanged && proofreadStore.items.length > 0) {
      const ranges: [number, number][] = []
      transaction.mapping.maps.forEach((m: any) => {
        m.forEach((from: number, to: number) => ranges.push([from, to]))
      })
      if (ranges.length) {
        const hit = proofreadStore.items.filter((it) =>
          ranges.some(([cf, ct]) => it.from < ct && cf < it.to),
        )
        hit.forEach((it) => proofreadStore.ignore(it.id))
      }
      proofreadStore.remap(transaction.mapping)
    }
    // IME 组合输入期间跳过：避免中途 emit 破坏输入法 composition 状态
    if (isComposing) return
    extractHeadings(editor.value)
    // ★ 核心保护：初始化期间 / 程序化同步期间 / syncing 标记期间，不 emit
    if (!initialized || syncDepth > 0 || syncing) return
    const ed = editor.value
    if (!ed) return

    if (props.editMode === 'material') {
      // 素材模式：发射 ProseMirror JSON（与文档模式一致，避免无限循环）
      const json = ed.getJSON()
      const current = typeof props.modelValue === 'object' ? props.modelValue : null
      if (stableJSON(json) !== stableJSON(current)) {
        emit('update:modelValue', json)
      }
    } else {
      // 文档模式：发射 ProseMirror JSON
      const json = ed.getJSON()
      const current = typeof props.modelValue === 'object' ? props.modelValue : null
      if (stableJSON(json) !== stableJSON(current)) {
        emit('update:modelValue', json)
      }
    }

    // 批注孤儿扫描：删除整段带批注的文字后，对应 comment 标 orphan；
    // ghost mark 引用了已删除的 comment → 主动清理
    nextTick(() => {
      if (syncing) return
      const { ghostIds } = docStore.sweepOrphans()
      if (ghostIds.length === 0) return
      const ed = editor.value
      if (!ed) return
      syncing = true
      // 不进 undo 栈：用户没主动删，幽灵 mark 自动清理
      const tr = ed.state.tr.setMeta('addToHistory', false)
      const markType = ed.state.schema.marks.comment
      if (markType) {
        ed.state.doc.descendants((node, pos) => {
          if (!node.marks) return
          for (const m of node.marks) {
            if (m.type === markType && m.attrs.commentId && ghostIds.includes(m.attrs.commentId)) {
              tr.removeMark(pos, pos + node.nodeSize, markType)
            }
          }
        })
        if (tr.docChanged) ed.view.dispatch(tr)
      }
      syncing = false
      // 同上：孤儿 mark 清理后回流到 currentContent，交给 1 秒防抖落库
      const json = ed.getJSON()
      const current = typeof props.modelValue === 'object' ? props.modelValue : null
      if (stableJSON(json) !== stableJSON(current)) {
        emit('update:modelValue', json)
      }
    })
  },
  onSelectionUpdate() {
    editorStateTick.value++
    const ed = editor.value
    if (!ed) return
    const { from, to, empty } = ed.state.selection
    const len = empty ? 0 : ed.state.doc.textBetween(from, to, '').length
    emit('selection-change', len)
  },
  editorProps: {
    attributes: {
      class: 'rich-editor-content',
    },
    handleDOMEvents: {
      compositionstart: () => {
        isComposing = true
        return false
      },
      compositionend: () => {
        isComposing = false
        // IME 提交完毕 → 延迟一帧让 ProseMirror 完成内容写入后，补发同步
        setTimeout(() => {
          const ed = editor.value
          if (!ed || !initialized || syncing) return
          extractHeadings(ed)
          const json = ed.getJSON()
          const current = typeof props.modelValue === 'object' ? props.modelValue : null
          if (stableJSON(json) !== stableJSON(current)) {
            emit('update:modelValue', json)
          }
        }, 0)
        return false
      },
      keydown: (_view, event) => {
        const ke = event as KeyboardEvent
        // Ctrl+F / Ctrl+H：使用内置查找替换，阻止浏览器原生查找窗口
        if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'f' || ke.key === 'F')) {
          ke.preventDefault()
          if (!searchOpen.value) {
            searchOpen.value = true
            setTimeout(() => searchInputRef.value?.focus(), 50)
          } else {
            searchInputRef.value?.focus()
          }
          return true
        }
        if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'g' || ke.key === 'G')) {
          ke.preventDefault()
          ke.stopPropagation()
          editor.value?.commands.toggleHighlight()
          return true
        }
        if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'h' || ke.key === 'H')) {
          ke.preventDefault()
          if (!searchOpen.value) searchOpen.value = true
          // Ctrl+H 打开面板并切换到「替换」输入框
          setTimeout(() => {
            const replaceInput = document.querySelector('.rich-search-input[placeholder="替换为..."]') as HTMLInputElement | null
            replaceInput?.focus()
          }, 50)
          return true
        }
        // Ctrl+1~4 → 标题 H1~H4
        if ((ke.ctrlKey || ke.metaKey) && !ke.shiftKey && ['1', '2', '3', '4'].includes(ke.key)) {
          ke.preventDefault()
          ke.stopPropagation()
          const level = parseInt(ke.key) as 1 | 2 | 3 | 4
          execHeading(level)
          return true
        }
        // Ctrl+. / Ctrl+Shift+. → 上标
        if ((ke.ctrlKey || ke.metaKey) && ke.code === 'Period') {
          ke.preventDefault()
          ke.stopPropagation()
          const ed = editor.value
          if (!ed) return true
          ed.chain().focus().toggleSuperscript().run()
          return true
        }
        // Ctrl+, / Ctrl+Shift+, → 下标
        if ((ke.ctrlKey || ke.metaKey) && ke.code === 'Comma') {
          ke.preventDefault()
          ke.stopPropagation()
          const ed = editor.value
          if (!ed) return true
          ed.chain().focus().toggleSubscript().run()
          return true
        }
        // Ctrl+Shift+X → 删除线
        if ((ke.ctrlKey || ke.metaKey) && ke.shiftKey && (ke.key === 'x' || ke.key === 'X')) {
          ke.preventDefault()
          ke.stopPropagation()
          execStrike()
          return true
        }
        // Tab / Shift+Tab → 缩进 / 减少缩进（不在表格内时）
        if (ke.key === 'Tab') {
          const ed = editor.value
          if (!ed) return false
          // 表格内由 TipTap Table 处理 Tab 导航，不拦截
          if (ed.isActive('table')) return false
          ke.preventDefault()
          if (ke.shiftKey) execOutdent()
          else execIndent()
          return true
        }
        if (ke.key === 'Backspace') {
          const ed = editor.value
          if (!ed) return false
          const { $from, empty } = ed.state.selection
          // 仅当光标折叠且在段落/标题的起始位置时生效
          if (!empty) return false
          if ($from.parentOffset !== 0) return false
          const attrs = ed.getAttributes('paragraph') || ed.getAttributes('heading')
          const indent = attrs.textIndent ? parseInt(attrs.textIndent) : 0
          if (indent > 0) {
            ke.preventDefault()
            ;(ed.commands as any).setTextIndent?.(Math.max(0, indent - INDENT_BACK_STEP))
            return true
          }
        }
        return false
      },
      wheel: (_view, event) => {
        if ((event as WheelEvent).ctrlKey) {
          event.preventDefault()
          pageZoom.value = Math.max(0.5, Math.min(2.0, pageZoom.value + ((event as WheelEvent).deltaY < 0 ? 0.05 : -0.05)))
          return true
        }
        return false
      },
      contextmenu: (_view, event) => {
        // 素材模式：回退浏览器/系统原生右键菜单，不弹自定义菜单
        //（选中动作已由悬浮工具条接管，见 showMatToolbar）
        if (props.editMode === 'material') {
          hideMatToolbar()
          return false
        }
        event.preventDefault()
        const ed = editor.value
        if (!ed) return false
        const { from, to } = ed.state.selection
        const selText = ed.state.doc.textBetween(from, to, ' ')
        ctxMenuSelText.value = selText
        ctxMenuSelFrom.value = from
        ctxMenuSelTo.value = to
        // 根据菜单内容估算尺寸
        const isDoc = !props.editMode || props.editMode === 'document'
        const hasText = !!selText
        let menuH = isDoc ? (hasText ? 246 : 105) : (hasText ? 228 : 70)
        const { x, y } = editorSmartMenuPos(event.clientX, event.clientY, 200, menuH)
        ctxMenuX.value = x
        ctxMenuY.value = y
        ctxMenuShow.value = true
        return true
      },
      // 批注 hover 浮层：mouseover 委托 .comment-mark / .comment-badge
      mouseover: (_view, event) => {
        const t = event.target as HTMLElement | null
        if (!t) return
        const el = t.closest('.comment-mark, .comment-badge') as HTMLElement | null
        if (el) {
          const id = el.getAttribute('data-comment-id')
          if (id && id !== '0') tooltipRef.value?.show(id, el)
          return
        }
        const pEl = t.closest('.proofread-underline') as HTMLElement | null
        if (pEl) {
          const pid = pEl.getAttribute('data-proofread-id')
          const issue = pid ? (proofreadStore.items.find((i) => i.id === pid) ?? null) : null
          if (issue) showProofreadTip(issue, pEl)
          return
        }
        // 不在批注/校对元素上 → 安排延迟关闭
        tooltipRef.value?.scheduleHide()
        scheduleHideProofreadTip()
      },
      mouseout: (_view, event) => {
        const t = event.target as HTMLElement | null
        if (!t) return
        const cEl = t.closest('.comment-mark, .comment-badge') as HTMLElement | null
        if (cEl) { tooltipRef.value?.scheduleHide(); return }
        const pEl = t.closest('.proofread-underline') as HTMLElement | null
        if (pEl) { scheduleHideProofreadTip(); return }
      },
      paste: (_view, event) => {
        const items = event.clipboardData?.items
        if (!items) return false
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            event.preventDefault()
            handleImagePaste(items[i])
            return true
          }
        }
        return false
      },
    },
  },
})

// ── 监听外部 modelValue 变更（父组件 → 编辑器） ──
// 渲染去重：基于「目标文档 id」而非「调用序号」。
// 同目标重复点击（大文档切换慢时用户补点）不会丢弃第一次渲染；只有「已切到别的文档」才丢弃旧渲染。
watch(
  () => props.modelValue,
  async (newVal) => {
    if (!editor.value) return
    const ed = editor.value
    const myDocId = docStore.currentDocId // 捕获本次切换的目标文档
    // 立即进入同步态：覆盖整个异步过程，阻止过期 onUpdate 把旧内容写回 currentContent
    syncing = true
    syncDepth++
    try {
      if (typeof newVal === 'object') {
        const currentJson = ed.getJSON()
        if (stableJSON(newVal) !== stableJSON(currentJson)) {
          const selFrom = ed.state.selection.from
          const prepared = await prepareContent(newVal)
          // 期间已切到别的文档 → 本次结果丢弃，交给更新的切换（防串稿）
          if (myDocId !== docStore.currentDocId) return
          ed.commands.setContent(prepared)
          try {
            const resolvedPos = Math.min(selFrom, ed.state.doc.content.size)
            ed.commands.setTextSelection(resolvedPos)
          } catch { /* 位置无效则保持默认 */ }
          extractHeadings(ed)
        }
      } else if (typeof newVal === 'string') {
        // 向后兼容：纯文本字符串 → 按段落拆分为 JSON 后设置
        await applyContent(newVal)
        if (myDocId !== docStore.currentDocId) return
      }
    } finally {
      // 无论本次是否仍是最新一次，都解除自身的同步计数，避免竞态后 syncDepth 永久停留导致打字无法回写保存
      syncDepth = Math.max(0, syncDepth - 1)
      syncing = syncDepth > 0
    }
  },
)

// ── 监听 readonly ──
watch(() => props.readonly, (v) => {
  editor.value?.setEditable(!v)
})

// ── 切换文档：清空校对结果（正词为全局，不清） ──
watch(() => docStore.currentDocId, (id) => {
  if (id) proofreadStore.initDoc(id)
})

// ── 教程文档自动展开大纲 ──
watch(() => props.autoShowOutline, (v) => {
  if (v) showOutline.value = true
})

// ── 外部搜索高亮：搜索面板点击结果后自动高亮 + 跳转 ──
watch(
  () => props.highlightQuery,
  async (q) => {
    if (!q || !editor.value) return;
    // 查找面板打开时不覆盖搜索面板的匹配结果
    if (searchOpen.value) return;
    // 等待组件 DOM 更新（modelValue prop 已到达组件）
    await nextTick();
    // 等待内容同步完成（modelValue watch 可能正在 async 加载并 setContent）
    for (let retry = 0; retry < 50 && (syncDepth > 0 || syncing); retry++) {
      await new Promise(r => setTimeout(r, 30));
    }
    const ed = editor.value;
    if (!ed) return;

    // 短延迟确保 setContent 后 ProseMirror 内部事务稳定
    await new Promise(r => setTimeout(r, 0));

    _searchMatches = [];
    const lowerQ = q.toLowerCase();
    ed.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      const text = node.text.toLowerCase();
      let offset = 0;
      while (offset < text.length) {
        const found = text.indexOf(lowerQ, offset);
        if (found === -1) break;
        _searchMatches.push({ from: pos + found, to: pos + found + lowerQ.length });
        offset = found + lowerQ.length;
      }
      return true;
    });
    applySearchDecorations();
    searchCount.value = _searchMatches.length;
    if (_searchMatches.length > 0) {
      searchIdx.value = 1;
      goToResult(0);
    }
  },
  { immediate: false }
)


// ── 清理 ──
onBeforeUnmount(() => {
  editor.value?.destroy()
})

// ── 批注浮层跳转桥接（CommentTooltip 通过 window CustomEvent 触发跳转） ──
function onCommentJumpFromTooltip(e: Event) {
  const detail = (e as CustomEvent<{ commentId: string }>).detail
  if (detail?.commentId) onCommentListJump(detail.commentId)
}
/** 全局拦截 Ctrl+F / Ctrl+G，防止浏览器原生查找栏弹出（连点两次时焦点可能在搜索输入框而非编辑器） */
function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    if (!searchOpen.value) {
      searchOpen.value = true
      setTimeout(() => searchInputRef.value?.focus(), 50)
    } else {
      searchInputRef.value?.focus()
    }
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault()
    execHighlight()
  }
  // Ctrl+1~4 → 标题 + 拦截浏览器切标签页
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault()
    const level = parseInt(e.key) as 1 | 2 | 3 | 4
    execHeading(level)
  }
  // Ctrl+. / Ctrl+Shift+. → 上标
  if ((e.ctrlKey || e.metaKey) && e.code === 'Period') {
    e.preventDefault()
    execSuperscript()
  }
  // Ctrl+, / Ctrl+Shift+, → 下标
  if ((e.ctrlKey || e.metaKey) && e.code === 'Comma') {
    e.preventDefault()
    execSubscript()
  }
  // Ctrl+Shift+X → 删除线
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'x' || e.key === 'X')) {
    e.preventDefault()
    execStrike()
  }
}
// ── 素材选中悬浮工具条（仅 editMode==='material'；ima 风格） ──
const matTbShow = ref(false)
const matTbX = ref(0)
const matTbY = ref(0)
const matTbPositioned = ref(false)
const matToolbarRef = ref<HTMLElement | null>(null)
let matPointerDown = false
let matSelDebounce: number | null = null
let matScrollLockHandler: ((ev: Event) => void) | null = null // 滚动锁定回调引用
const matNoteShow = ref(false) // 笔记下拉面板
const matNoteDropdownRef = ref<HTMLElement | null>(null)

function matRemoveScrollLock() {
  if (matScrollLockHandler) {
    window.removeEventListener('wheel', matScrollLockHandler, { passive: false } as any)
    window.removeEventListener('touchmove', matScrollLockHandler, { passive: false } as any)
    matScrollLockHandler = null
  }
}

function matAddScrollLock() {
  matRemoveScrollLock()
  matScrollLockHandler = function (ev: Event) {
    // 笔记下拉面板内部滚动放行
    const target = ev.target as HTMLElement | null
    if (target && matNoteDropdownRef.value && matNoteDropdownRef.value.contains(target)) return
    ev.preventDefault()
  }
  window.addEventListener('wheel', matScrollLockHandler, { passive: false })
  window.addEventListener('touchmove', matScrollLockHandler, { passive: false })
}

function hideMatToolbar() {
  matNoteShow.value = false
  matNoteCancelHide()
  matRemoveScrollLock()
  matTbShow.value = false
  matTbPositioned.value = false
}

/** 判断当前浏览器选区是否落在本编辑器 DOM 内（多素材卡片隔离） */
function matSelInThisEditor(sel: Selection | null): boolean {
  const ed = editor.value
  if (!ed || !sel || sel.rangeCount === 0) return false
  const dom = ed.view.dom as HTMLElement
  const anchor = sel.anchorNode
  return !!anchor && dom.contains(anchor)
}

async function showMatToolbar() {
  if (props.editMode !== 'material') return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideMatToolbar(); return }
  const selText = sel.toString().trim()
  if (!selText) { hideMatToolbar(); return }
  if (!matSelInThisEditor(sel)) { hideMatToolbar(); return }
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) { hideMatToolbar(); return }
  // 供 execCtxMenu* 复用选中文本
  ctxMenuSelText.value = selText
  matTbPositioned.value = false
  matTbX.value = rect.left
  matTbY.value = rect.top
  matTbShow.value = true
  await nextTick()
  const el = matToolbarRef.value
  if (!el) return
  const w = el.offsetWidth
  const h = el.offsetHeight
  const vw = window.innerWidth
  let left = rect.left + rect.width / 2 - w / 2
  let top = rect.top - h - 8
  if (top < 4) top = rect.bottom + 8            // 上方空间不足 → 翻转到下方
  if (left < 4) left = 4                          // 水平夹取，不出界
  if (left + w > vw - 4) left = vw - w - 4
  if (top < 4) top = 4
  matTbX.value = left
  matTbY.value = top
  matTbPositioned.value = true
  matAddScrollLock() // 锁定底层滚动（与浏览器工具栏行为一致）
}

function onMatSelectionChange() {
  if (props.editMode !== 'material') return
  if (matPointerDown) return // 鼠标拖选中途不处理，等 mouseup
  if (matSelDebounce) clearTimeout(matSelDebounce)
  matSelDebounce = window.setTimeout(() => {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim() && matSelInThisEditor(sel)) showMatToolbar()
    else hideMatToolbar()
  }, 120)
}
function onMatMouseDown(e: MouseEvent) {
  if (props.editMode !== 'material') return
  const el = matToolbarRef.value
  if (el && el.contains(e.target as Node)) return // 点工具条内部不处理
  const ndd = matNoteDropdownRef.value
  if (ndd && ndd.contains(e.target as Node)) return // 点笔记下拉内部不处理
  matPointerDown = true
  hideMatToolbar()
}
function onMatMouseUp(e: MouseEvent) {
  if (props.editMode !== 'material') return
  matPointerDown = false
  if (e.button === 2) return // 右键：回退原生菜单，不弹工具条
  const el = matToolbarRef.value
  if (el && el.contains(e.target as Node)) return
  setTimeout(() => {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim() && matSelInThisEditor(sel)) showMatToolbar()
    else hideMatToolbar()
  }, 0)
}
function onMatScrollOrResize(e?: Event) {
  if (props.editMode !== 'material') return
  // 笔记下拉面板内部滚动不隐藏工具栏
  if (e && e.target && matNoteDropdownRef.value?.contains(e.target as Node)) return
  hideMatToolbar() // 素材：滚动即隐藏（§2.5，最简稳妥）
}
function onMatKeydown(e: KeyboardEvent) {
  if (props.editMode !== 'material') return
  if (e.key === 'Escape') hideMatToolbar()
}

// 工具条按钮：复用现有 execCtxMenu* 内部逻辑，再收起工具条
function matCopy() { execCtxMenuCopy(); hideMatToolbar() }
function matChat() { execCtxMenuInsertToChat(); hideMatToolbar() }
function matCandidate() { execCtxMenuAddToCandidate(); hideMatToolbar() }
function matCompare() { execCtxMenuAddToCompare(); hideMatToolbar() }
let matNoteHideTimer: ReturnType<typeof setTimeout> | null = null
function matNoteScheduleHide() {
  matNoteCancelHide()
  matNoteHideTimer = setTimeout(() => {
    matNoteShow.value = false
  }, 150)
}
function matNoteCancelHide() {
  if (matNoteHideTimer) { clearTimeout(matNoteHideTimer); matNoteHideTimer = null }
}
function matNoteCreateNew() {
  if (ctxMenuSelText.value) {
    emit('material-add-to-note', ctxMenuSelText.value)
  }
  hideMatToolbar()
}
function matNoteAppendToDoc(docId: string) {
  if (ctxMenuSelText.value) {
    emit('material-append-to-doc', { docId, text: ctxMenuSelText.value })
  }
  hideMatToolbar()
}
/** 笔记下拉显示的文档列表（下拉打开时实时获取） */
const matNoteDocList = computed(() => {
  return (docStore.documents || []).map(d => ({ id: d.id, title: d.title }))
})

onMounted(() => {
  window.addEventListener('comment-jump', onCommentJumpFromTooltip)
  document.addEventListener('keydown', onGlobalKeydown)
  if (props.editMode === 'material') {
    document.addEventListener('selectionchange', onMatSelectionChange)
    document.addEventListener('mousedown', onMatMouseDown, true)
    document.addEventListener('mouseup', onMatMouseUp, true)
    window.addEventListener('scroll', onMatScrollOrResize, true)
    window.addEventListener('resize', onMatScrollOrResize)
    document.addEventListener('keydown', onMatKeydown)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('comment-jump', onCommentJumpFromTooltip)
  document.removeEventListener('keydown', onGlobalKeydown)
  if (props.editMode === 'material') {
    document.removeEventListener('selectionchange', onMatSelectionChange)
    document.removeEventListener('mousedown', onMatMouseDown, true)
    document.removeEventListener('mouseup', onMatMouseUp, true)
    window.removeEventListener('scroll', onMatScrollOrResize, true)
    window.removeEventListener('resize', onMatScrollOrResize)
    document.removeEventListener('keydown', onMatKeydown)
    if (matSelDebounce) clearTimeout(matSelDebounce)
  }
})

// ── 工具栏操作 ──
function focus() { editor.value?.chain().focus().run() }

function execBold() { focus(); editor.value?.chain().toggleBold().run() }
function execItalic() { focus(); editor.value?.chain().toggleItalic().run() }
function execUnderline() { focus(); editor.value?.chain().toggleUnderline().run() }
function execStrike() { focus(); editor.value?.chain().toggleStrike().run() }
function execHighlight() { focus(); editor.value?.chain().toggleHighlight({ color: '#FFFF00' }).run() }

// ── 符号面板 ──
const symbolPanelOpen = ref(false)
const SYMBOLS = ['．', '〔', '〕', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

function toggleSymbolPanel() { closeAllPickers(); symbolPanelOpen.value = !symbolPanelOpen.value }
function insertSymbol(ch: string) {
  focus(); editor.value?.chain().insertContent(ch).run()
  symbolPanelOpen.value = false
}

// ── 引号修正（直引号 " → 中文弯引号 “ ”）──
// 规则：按 block 内奇偶配对，第 1/3/5 个 " → 左引号 “，第 2/4/6 个 " → 右引号 ”。
// 作用域：有选区 → 只处理选区；无选区 → 处理全文。
// 安全策略：等长替换 + 单个 transaction + 从后往前 insertText + 映射光标，避免位置错乱与光标跳脱。
const quoteFixMsg = ref('')
let quoteFixMsgTimer: ReturnType<typeof setTimeout> | null = null
function showQuoteFixMsg(text: string) {
  quoteFixMsg.value = text
  if (quoteFixMsgTimer) clearTimeout(quoteFixMsgTimer)
  quoteFixMsgTimer = setTimeout(() => { quoteFixMsg.value = '' }, 2500)
}

function fixCurlyQuotes() {
  const ed = editor.value
  if (!ed) return
  const { doc } = ed.state
  const { from: selFrom, to: selTo, empty } = ed.state.selection
  // 作用域：无选区 → 全文；有选区 → 选区范围
  const scopeFrom = empty ? 0 : selFrom
  const scopeTo = empty ? doc.content.size : selTo

  // 收集所有需替换的直引号位置（绝对位置 + 目标弯引号）
  const replacements: { from: number; to: number; ch: string }[] = []
  doc.nodesBetween(scopeFrom, scopeTo, (node, pos) => {
    // 跳过代码块整体
    if (node.type.name === 'codeBlock') return false
    // 仅处理文本块（段落 / 标题等），非文本块继续向下遍历
    if (!node.isTextblock) return true
    // 每个 block 独立奇偶配对
    let openNext = true
    let childOffset = 0
    node.forEach((child) => {
      const childStart = pos + 1 + childOffset
      childOffset += child.nodeSize
      if (!child.isText || !child.text) return
      // 跳过行内 code 标记
      if (child.marks.some((m) => m.type.name === 'code')) return
      const text = child.text
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '"') continue
        const abs = childStart + i
        if (abs < scopeFrom || abs >= scopeTo) continue
        replacements.push({ from: abs, to: abs + 1, ch: openNext ? '\u201C' : '\u201D' })
        openNext = !openNext
      }
    })
    return false // 已手动处理该文本块内容，不再向下
  })

  if (replacements.length === 0) {
    showQuoteFixMsg(empty ? '全文未发现需修正的引号' : '选区未发现需修正的引号')
    return
  }

  // 单个 transaction，从后往前替换（等长，位置不偏移）
  replacements.sort((a, b) => b.from - a.from)
  let tr = ed.state.tr
  for (const r of replacements) {
    tr = tr.insertText(r.ch, r.from, r.to)
  }
  // 映射光标 / 选区回新文档，避免跳脱
  const mappedFrom = tr.mapping.map(selFrom)
  const mappedTo = tr.mapping.map(selTo)
  tr = tr.setSelection(TextSelection.create(tr.doc, mappedFrom, mappedTo))
  // 直接派发，不抢焦点、不强制滚动
  ed.view.dispatch(tr)
  editorStateTick.value++
  clearSearchHighlights()
  showQuoteFixMsg(`已修正 ${replacements.length} 处引号`)
}

// ── 批注输入浮层状态 ──
const commentBarVisible = ref(false)
const commentBarPosition = ref({ top: 0, left: 0 })
const commentPendingAnchor = ref<{ from: number; to: number } | null>(null)
const tooltipRef = ref<InstanceType<typeof CommentTooltip> | null>(null)

/**
 * 工具栏 / 右键触发"插入批注"
 *  - 校验选区非空
 *  - 校验单段内（v1 限制）
 *  - 弹出输入浮层
 */
function execComment() {
  const ed = editor.value
  if (!ed) return
  // 素材模式下不允许插入批注（与工具栏/右键菜单的隐藏策略一致）
  if (props.editMode === 'material') return
  const { from, to, empty } = ed.state.selection
  if (empty) {
    // 给个轻提示（用临时 DOM 提示，避免引新依赖）
    showToolbarHint('请先选中要批注的文字')
    return
  }
  // 单段内校验
  const $from = ed.state.doc.resolve(from)
  const $to = ed.state.doc.resolve(to)
  if ($from.parent !== $to.parent) {
    showToolbarHint('批注暂不支持跨段，请选择同一段内的文字')
    return
  }
  // 计算浮层位置：选区中点水平居中 + 下方；自动避左右 + 翻上下
  const start = ed.view.coordsAtPos(from)
  const end = ed.view.coordsAtPos(to)
  const midX = (start.left + end.right) / 2
  const { top, left } = editorSmartMenuPosCenter(midX, end.bottom, 280, 160)
  commentBarPosition.value = { top, left }
  commentPendingAnchor.value = { from, to }
  commentBarVisible.value = true
}

function onCommentConfirm(text: string) {
  const ed = editor.value
  const anchor = commentPendingAnchor.value
  if (!ed || !anchor) {
    commentBarVisible.value = false
    return
  }
  // 1. 写 store（生成 comment + id + order）
  const c = docStore.addComment(text)
  // 2. 在选区加 mark
  ed.chain()
    .focus()
    .setTextSelection({ from: anchor.from, to: anchor.to })
    .setMark('comment', { commentId: c.id })
    .run()
  // 3. 关闭浮层
  commentBarVisible.value = false
  commentPendingAnchor.value = null
  // 4. 触发 mark+comments 同步（forceUpdate 让 modelValue 写出 comments）
  //    onUpdate 内部会自动发射 modelValue，watch store.comments 触发角标刷新
  editorStateTick.value++
}

function onCommentCancel() {
  commentBarVisible.value = false
  commentPendingAnchor.value = null
}

/** 文末列表跳转：在编辑器中定位首个带该 commentId 的 mark，滚动到可视区 */
function onCommentListJump(commentId: string) {
  const ed = editor.value
  if (!ed) return
  let targetPos: number | null = null
  ed.state.doc.descendants((node, pos) => {
    if (targetPos !== null) return false
    if (!node.marks) return
    for (const m of node.marks) {
      if (m.type.name === 'comment' && m.attrs.commentId === commentId) {
        targetPos = pos
        return false
      }
    }
  })
  if (targetPos === null) return
  // 选中该 mark 范围起点 + 滚动到可视区
  ed.commands.focus()
  ed.commands.setTextSelection(targetPos)
  // 平滑滚动
  nextTick(() => {
    const dom = ed.view.nodeDOM(targetPos!) as HTMLElement | null
    dom?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

/** 校对结果跳转：定位到该问题区间并滚动到可视区 */
function onProofreadJump(id: string) {
  const ed = editor.value
  if (!ed) return
  const it = proofreadStore.items.find((i) => i.id === id)
  if (!it) return
  ed.commands.focus()
  try {
    ed.commands.setTextSelection({ from: it.from, to: it.to })
  } catch {
    return
  }
  nextTick(() => {
    try {
      const dom = ed.view.domAtPos(it.from)
      const el = (dom.node.nodeType === 3 ? dom.node.parentElement : dom.node) as HTMLElement | null
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch { /* DOM 已卸载 */ }
  })
}

/** 校对结果替换：用建议文本替换问题区间（docChanged 后编辑即删会自动移除该项） */
function onProofreadReplace(id: string) {
  const ed = editor.value
  if (!ed) return
  const it = proofreadStore.items.find((i) => i.id === id)
  if (!it) return
  ed.chain()
    .focus()
    .setTextSelection({ from: it.from, to: it.to })
    .insertContent(it.suggestion)
    .run()
}

/** 工具栏轻量提示（浮在按钮上方 800ms 自动消失） */
const toolbarHint = ref('')
let toolbarHintTimer: ReturnType<typeof setTimeout> | null = null
function showToolbarHint(msg: string) {
  toolbarHint.value = msg
  if (toolbarHintTimer) clearTimeout(toolbarHintTimer)
  toolbarHintTimer = setTimeout(() => { toolbarHint.value = '' }, 1800)
}
function execSuperscript() { focus(); editor.value?.chain().toggleSuperscript().run() }
function execSubscript() { focus(); editor.value?.chain().toggleSubscript().run() }
function execClearFormat() {
  focus()
  const ed = editor.value
  if (!ed) return

  // 保存段落级排版属性（缩进、对齐、行高等，清除格式时不应丢失）
  const { $from } = ed.state.selection
  const p = $from.parent
  const keepAttrs: Record<string, any> = {}
  if (p.attrs?.textIndent) keepAttrs.textIndent = p.attrs.textIndent
  if (p.attrs?.textAlign) keepAttrs.textAlign = p.attrs.textAlign
  if (p.attrs?.lineHeight) keepAttrs.lineHeight = p.attrs.lineHeight

  // 清除节点样式 + 内联标记 + 字体 → 回归默认三号方正仿宋简体
  ed.chain().focus().clearNodes().unsetAllMarks().unsetFontSize().unsetFontFamily().run()

  // 恢复被 clearNodes() 误删的段落排版属性
  if (Object.keys(keepAttrs).length > 0) {
    ed.chain().focus().updateAttributes('paragraph', keepAttrs).run()
  }
}

/** 每次缩进步进 = 2 个字符宽度（em） */
const INDENT_STEP = 2
/** Backspace 回退步进 = 1 个字符宽度（em） */
const INDENT_BACK_STEP = 1

function execIndent() {
  focus()
  const ed = editor.value
  if (!ed) return
  const attrs = ed.getAttributes('paragraph') || ed.getAttributes('heading')
  const current = attrs.textIndent ? parseInt(attrs.textIndent) : 0
  ;(ed.commands as any).setTextIndent?.(current + INDENT_STEP)
}
function execOutdent() {
  focus()
  const ed = editor.value
  if (!ed) return
  const attrs = ed.getAttributes('paragraph') || ed.getAttributes('heading')
  const current = attrs.textIndent ? parseInt(attrs.textIndent) : 0
  if (current > 0) {
    ;(ed.commands as any).setTextIndent?.(Math.max(0, current - INDENT_STEP))
  }
}

function execHeading(level: number) {
  focus()
  const ed = editor.value
  if (!ed) { headingDropdownOpen.value = false; return }

  const { from, to, empty } = ed.state.selection
  const $from = ed.state.doc.resolve(from)
  const $to = ed.state.doc.resolve(to)

  // Word 风格：判断是"整段操作"还是"选中部分文字"
  // 整段 = 光标无选区 + 同一段落内选中覆盖了全部文字内容
  const sameBlock = $from.parent.eq($to.parent)
  const blockStart = $from.start(1)   // 段落起始位（含 opening token）
  const blockEnd = $from.end(1)       // 段落结束位（含 closing token）
  const isWholeBlock = empty || (sameBlock && from <= blockStart + 1 && to >= blockEnd - 1)

  // 标题样式参数
  const fontMap: Record<number, string> = { 1: es().fontH1, 2: es().fontH2, 3: es().fontH3, 4: es().fontH4 }
  const sizeMap: Record<number, number> = { 1: es().sizeH1, 2: es().sizeH2, 3: es().sizeH3, 4: es().sizeH4 }
  const boldMap: Record<number, boolean> = { 1: es().boldH1, 2: es().boldH2, 3: es().boldH3, 4: es().boldH4 }

  if (level === 0) {
    // 正文：清除标题节点，清除行内字号/字体标记让 CSS 接管
    ed.chain().setParagraph().run()
    ed.chain().focus().unsetFontSize().unsetFontFamily().run()
    if (es().boldBody) ed.chain().focus().setBold().run()
    else ed.chain().focus().unsetBold().run()
  } else if (isWholeBlock) {
    // ——— Word 行为2：整段标题转换 ———
    const wasActive = ed.isActive('heading', { level })
    ed.chain().toggleHeading({ level: level as 1 | 2 | 3 | 4 }).run()
    // 清除行内字体标记（CSS 通过 h1-h4 规则控制视觉，含加粗）
    ed.chain().focus().unsetFontSize().unsetFontFamily().run()
    // 如果是从标题切回正文，确保正文加粗状态正确
    if (wasActive && es().boldBody) ed.chain().focus().setBold().run()
    else if (wasActive) ed.chain().focus().unsetBold().run()
  } else {
    // ——— Word 行为1：选中部分文字 → 只改字体/字号/加粗，段落不变 ———
    const font = fontMap[level]
    const size = sizeMap[level]

    // 检查选中文字是否已有该标题的字体样式 → 做 toggle
    const marks = ed.state.selection.$from.marks()
    const hasThisHeadingStyle = marks.some(m => {
      if (m.type.name === 'textStyle') {
        return m.attrs.fontFamily === font
          && Math.abs((m.attrs.fontSize || 0) - size) < 0.1
      }
      return false
    })

    if (hasThisHeadingStyle) {
      // 已应用 → 恢复正文默认字体/字号
      ed.chain().focus().unsetFontSize().unsetFontFamily().run()
      if (es().boldBody) ed.chain().focus().setBold().run()
      else ed.chain().focus().unsetBold().run()
    } else {
      ed.chain().focus().setFontFamily(font).setFontSize(size + 'pt').run()
      if (boldMap[level]) ed.chain().focus().setBold().run()
      else ed.chain().focus().unsetBold().run()
    }
  }
  headingDropdownOpen.value = false
}

function execAlign(dir: 'left' | 'center' | 'right' | 'justify') {
  focus(); editor.value?.chain().setTextAlign(dir).run()
}
function execHr() { focus(); editor.value?.chain().setHorizontalRule().run() }
function execUndo() { focus(); editor.value?.chain().undo().run() }
function execRedo() { focus(); editor.value?.chain().redo().run() }

async function execImage() {
  try {
    console.log('[execImage] 开始选择图片...')
    const selected = await open({
      title: '选择图片',
      multiple: false,
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
    })
    const sourcePath: string | null = Array.isArray(selected) ? selected[0] : selected
    console.log('[execImage] 选择的文件:', sourcePath)
    if (!sourcePath) return
    console.log('[execImage] 正在保存到本地目录...')
    const result = await saveImageToLocalDir(sourcePath)
    console.log('[execImage] 保存成功, savedPath:', result.savedPath, 'imageUrl:', result.imageUrl)
    focus()
    console.log('[execImage] 正在插入到编辑器...')
    ;(editor.value?.chain() as any).setImage({ src: result.imageUrl, localPath: result.savedPath }).run()
    console.log('[execImage] 插入完成')
  } catch (e) {
    console.error('[execImage] 插入图片失败:', e)
    alert('插入图片失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}



/** 复制图片到本地持久化目录，返回 本地路径 + data URL */
async function saveImageToLocalDir(sourcePath: string): Promise<{ savedPath: string; imageUrl: string }> {
  console.log('[saveImageToLocalDir] 读取原始文件:', sourcePath)
  const ext = sourcePath.split('.').pop()?.toLowerCase() || 'png'
  const dir = await join(await appLocalDataDir(), 'images')
  const fileName = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`
  const savedPath = await join(dir, fileName)
  console.log('[saveImageToLocalDir] 保存到:', savedPath)
  // 通过 Rust 命令 读 + 存，绕过 fs 插件权限范围问题
  const bytes = await invoke<number[]>('save_image_file', { sourcePath, destPath: savedPath })
  console.log('[saveImageToLocalDir] 保存完成, 字节数:', bytes?.length ?? 0)
  if (!bytes || bytes.length === 0) throw new Error('保存的图片数据为空')
  const dataUrl = await bytesToDataUrl(new Uint8Array(bytes), ext)
  return { savedPath, imageUrl: dataUrl }
}


/** 粘贴图片 → 保存到本地持久化目录 + 双属性存储 */
async function handleImagePaste(item: DataTransferItem) {
  const file = item.getAsFile()
  if (!file) return
  // 防止超大图片导致 OOM（截图/无损原图可能上百 MB）
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB
  if (file.size > MAX_IMAGE_SIZE) {
    alert('图片过大，请压缩后再粘贴。')
    return
  }
  try {
    const buf = await file.arrayBuffer()
    let ext = file.type.split('/')[1] || 'png'
    if (ext === 'jpeg') ext = 'jpg'
    if (ext === 'svg+xml') ext = 'svg'
    const dir = await join(await appLocalDataDir(), 'images')
    const fileName = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`
    const filePath = await join(dir, fileName)
    // 通过 Rust 命令写文件，绕过 fs 插件权限范围问题
    await invoke('save_image_bytes', { path: filePath, data: Array.from(new Uint8Array(buf)) })
    const dataUrl = await bytesToDataUrl(new Uint8Array(buf), ext)
    focus()
    ;(editor.value?.chain() as any).setImage({ src: dataUrl, localPath: filePath }).run()
  } catch (e) {
    console.error('图片粘贴失败:', e)
  }
}



// ── 活动状态 ──
const active = computed(() => ({
  bold: editor.value?.isActive('bold') ?? false,
  italic: editor.value?.isActive('italic') ?? false,
  underline: editor.value?.isActive('underline') ?? false,
  strike: editor.value?.isActive('strike') ?? false,
  highlight: editor.value?.isActive('highlight') ?? false,
  comment: editor.value?.isActive('comment') ?? false,
  superscript: editor.value?.isActive('superscript') ?? false,
  subscript: editor.value?.isActive('subscript') ?? false,
  alignLeft: editor.value?.isActive({ textAlign: 'left' }) ?? false,
  alignCenter: editor.value?.isActive({ textAlign: 'center' }) ?? false,
  alignRight: editor.value?.isActive({ textAlign: 'right' }) ?? false,
  alignJustify: editor.value?.isActive({ textAlign: 'justify' }) ?? false,
  heading1: editor.value?.isActive('heading', { level: 1 }) ?? false,
  heading2: editor.value?.isActive('heading', { level: 2 }) ?? false,
  heading3: editor.value?.isActive('heading', { level: 3 }) ?? false,
  heading4: editor.value?.isActive('heading', { level: 4 }) ?? false,
  paragraph: editor.value ? !editor.value.isActive('heading') : true,
}))

const currentHeadingLabel = computed(() => {
  if (active.value.heading1) return 'H1'
  if (active.value.heading2) return 'H2'
  if (active.value.heading3) return 'H3'
  if (active.value.heading4) return 'H4'
  return '正文'
})

// ── 暴露给父组件 ──
defineExpose({
  getSelectedText: () => {
    const ed = editor.value
    if (!ed) return ''
    const { from, to } = ed.state.selection
    return ed.state.doc.textBetween(from, to, ' ')
  },
  /** 获取当前 ProseMirror 文档的 JSON */
  getPMJson: () => {
    const ed = editor.value
    if (!ed) return null
    return ed.getJSON()
  },
  scrollToBottom: () => {
    const el = document.querySelector('.rich-editor-content')?.parentElement
    if (el) el.scrollTop = el.scrollHeight
  },
  scrollToPosition: (pos: number) => {
    const el = document.querySelector('.rich-editor-content')?.parentElement
    if (!el) return
    // 根据位置比例滚动
    const ed = editor.value
    if (!ed) { el.scrollTop = el.scrollHeight; return }
    const ratio = Math.min(1, Math.max(0, pos / Math.max(1, ed.state.doc.content.size)))
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
  },
  highlightRange: (_from: number, _to: number, _duration = 800) => {
    // ProseMirror 中基于字符偏移的高亮通过 setContentWithHighlight 实现
  },
  applyRangeChange: (_from: number, _to: number, insertJson: any) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    if (insertJson && typeof insertJson === 'object' && insertJson.type === 'doc') {
      ed.commands.setContent(insertJson)
    }
    syncing = false
  },
  /** 直接设置 ProseMirror JSON 内容（绕过 v-model），用于 diff 回放高亮 */
  setContentDirect: (json: any) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    if (json && typeof json === 'object') {
      ed.commands.setContent(json)
    }
    syncing = false
  },
  /** 设置干净的 JSON 内容（等同 applyContent，供父组件在 diff 回放中清除高亮） */
  setContentClean: (json: any) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    if (json && typeof json === 'object') {
      ed.commands.setContent(json)
    }
    syncing = false
  },
  /** 设置 JSON 内容并在指定区间包裹高亮。rawTextLen 可选，用于比例映射偏移。 */
  setContentWithHighlight: (json: any, hlStart: number, hlEnd: number, rawTextLen?: number) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    try {
      if (json && typeof json === 'object') {
        ed.commands.setContent(json)
      }
      if (hlStart >= 0 && hlEnd > hlStart) {
        let oFrom = hlStart, oTo = hlEnd
        if (rawTextLen && rawTextLen > 0) {
          const pmLen = Math.max(1, ed.state.doc.textContent.length)
          const s = pmLen / rawTextLen
          oFrom = Math.max(0, Math.floor(hlStart * s))
          oTo = Math.min(pmLen, Math.ceil(hlEnd * s))
          if (oTo <= oFrom) oTo = oFrom + 1
        }
        const docPosFrom = textOffsetToDocPos(ed, oFrom)
        const docPosTo = textOffsetToDocPos(ed, oTo)
        if (docPosFrom > 0 && docPosTo > docPosFrom) {
          ed.chain().setTextSelection({ from: docPosFrom, to: docPosTo }).setMark('diffHighlight').run()
        }
      }
    } catch { /* 忽略高亮失败 */ }
    syncing = false
  },
})

// ── SVG 图标 ──
const svg = {
  undo: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  redo: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  bold: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>`,
  italic: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>`,
  underline: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>`,
  strike: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 11.5H6.5"/><path d="M15 6.5a4 4 0 0 0-4-4c-2.5 0-4.5 2-4.5 4.5 0 1.7.8 3.2 2.1 4"/><path d="M9 17.5a4 4 0 0 0 4 4c2.5 0 4.5-2 4.5-4.5 0-1.7-.8-3.2-2.1-4"/></svg>`,
  // 倾斜荧光笔：笔尖向下，笔身填半透明黄，笔帽分节
  highlighter: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-9 9H5v-6z" fill="#fde047" fill-opacity="0.55"/><line x1="14" y1="4" x2="20" y2="10"/><line x1="17" y1="7" x2="21" y2="3"/></svg>`,
  // "A" 字 + 下方彩色色带：Word/Google Docs 通用"字体颜色"约定
  // A 顶点 (12,5) 居中，底脚对称在 x=3 / x=21，色带居中于 x=12
  textColor: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20 L11 5 H13 L21 20"/><line x1="6" y1="15" x2="18" y2="15"/><line x1="5" y1="22" x2="19" y2="22" stroke="#ef4444" stroke-width="2"/></svg>`,
  alignLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="17" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  alignCenter: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="18" y1="14" x2="6" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  alignRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="7" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  alignJustify: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  hr: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>`,
  table: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  image: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  sun: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  moon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  superscript: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l8-8"/><path d="M12 19l-8-8"/><path d="M20 12h-4c1-2 2-3 2-4 0-1-.8-2-2-2s-2 1-2 2"/></svg>`,
  subscript: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l8-8"/><path d="M12 19l-8-8"/><path d="M20 20h-4c1-2 2-3 2-4 0-1-.8-2-2-2s-2 1-2 2"/></svg>`,
  // 橡皮擦：斜长方体 + 底部接触面 + 擦痕
  clearFormat: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21h20"/><path d="m7 20-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 20"/></svg>`,
  comment: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>`,
  // 校对：放大镜 + 对勾（波浪线由编辑器渲染，此处仅作入口图标）
  proofread: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M8.5 11.5l1.8 1.8 3.2-3.6"/></svg>`,
  indent: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><polyline points="7 10 9 12 7 14"/></svg>`,
  outdent: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><polyline points="17 10 15 12 17 14"/></svg>`,
  // ── 表格操作图标 ──
  addRowAbove: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="8 9 12 5 16 9"/><line x1="4" y1="21" x2="20" y2="21"/><line x1="4" y1="17" x2="20" y2="17"/></svg>`,
  addRowBelow: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="3" x2="20" y2="3"/><line x1="4" y1="7" x2="20" y2="7"/><line x1="12" y1="19" x2="12" y2="5"/><polyline points="8 15 12 19 16 15"/></svg>`,
  addColumnLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="9 8 5 12 9 16"/><line x1="3" y1="4" x2="3" y2="20"/><line x1="7" y1="4" x2="7" y2="20"/></svg>`,
  addColumnRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="4" x2="17" y2="20"/><line x1="21" y1="4" x2="21" y2="20"/><line x1="5" y1="12" x2="19" y2="12"/><polyline points="15 8 19 12 15 16"/></svg>`,
  deleteRow: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/><line x1="9" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/></svg>`,
  deleteColumn: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/><line x1="8" y1="5" x2="8" y2="19"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="16" y1="5" x2="16" y2="19"/></svg>`,
  deleteTable: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/></svg>`,
  mergeCells: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="7" height="6" rx="1"/><rect x="14" y="5" width="7" height="6" rx="1"/><rect x="3" y="13" width="18" height="6" rx="1"/><line x1="10" y1="8" x2="14" y2="8"/></svg>`,
  splitCell: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/><line x1="11" y1="8" x2="13" y2="8"/><line x1="11" y1="12" x2="13" y2="12"/><line x1="11" y1="16" x2="13" y2="16"/></svg>`,
  toggleHeader: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/><line x1="15" y1="9" x2="15" y2="21"/><rect x="5" y="5" width="2" height="2" fill="currentColor" stroke="none"/></svg>`,
  printer: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 12H4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
  // Ω 符号图标：用 text 居中渲染，字号与 14×14 图标视觉重量一致
  symbol: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" stroke="none" style="font-family: 'Times New Roman', serif; line-height: 1"><text x="7" y="11" text-anchor="middle" font-size="14" font-weight="600" dominant-baseline="alphabetic">Ω</text></svg>`,
  // 引号修正图标：渲染左双引号 “
  quoteFix: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" stroke="none" style="font-family: 'Times New Roman', serif; line-height: 1"><text x="7" y="13" text-anchor="middle" font-size="18" font-weight="700" dominant-baseline="alphabetic">\u201C</text></svg>`,
  outline: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  fullscreen: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  minus: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  plus: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
}

// ── 按钮辅助 ──
function btnClass(active: boolean) {
  return active ? 'rich-btn rich-btn-active' : 'rich-btn'
}
</script>

<template>
  <div class="relative flex flex-col h-full min-h-0 rich-editor-wrapper" :class="{ 'is-material': editMode === 'material' }" :style="{ backgroundColor: contentBg, '--mat-font-family': materialFontFamily || undefined, '--mat-font-size': materialFontSize || undefined }">
    <!-- 工具栏（只读素材卡片隐藏，避免每个卡片都带一条工具栏） -->
    <div
      v-if="!(editMode === 'material' && readonly)"
      class="rich-toolbar flex items-center gap-0.5 px-1.5 py-1 border-b shrink-0 flex-wrap select-none"
      :style="{ backgroundColor: tbBg, borderColor: tbBorder }"
    >
      <!-- ── 导航 ── -->
      <button title="大纲导航" class="rich-btn" :class="{ 'rich-btn-active': showOutline }" @mousedown.prevent="showOutline = !showOutline" v-html="svg.outline" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 编辑历史 ── -->
      <button title="撤销 Ctrl+Z" class="rich-btn" @mousedown.prevent="execUndo" v-html="svg.undo" />
      <button title="重做 Ctrl+Y" class="rich-btn" @mousedown.prevent="execRedo" v-html="svg.redo" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 基础文字格式 ── -->
      <button title="粗体 Ctrl+B" :class="btnClass(active.bold)" @mousedown.prevent="execBold" v-html="svg.bold" />
      <button title="斜体 Ctrl+I" :class="btnClass(active.italic)" @mousedown.prevent="execItalic" v-html="svg.italic" />
      <button title="下划线 Ctrl+U" :class="btnClass(active.underline)" @mousedown.prevent="execUnderline" v-html="svg.underline" />
      <button title="删除线 Ctrl+Shift+X" :class="btnClass(active.strike)" @mousedown.prevent="execStrike" v-html="svg.strike" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 高级文字样式 ── -->
      <button title="上标 Ctrl+. / Ctrl+Shift+." :class="btnClass(active.superscript)" @mousedown.prevent="execSuperscript" v-html="svg.superscript" />
      <button title="下标 Ctrl+, / Ctrl+Shift+," :class="btnClass(active.subscript)" @mousedown.prevent="execSubscript" v-html="svg.subscript" />

      <div class="relative">
        <button
          title="文字颜色"
          class="rich-btn"
          @mousedown.prevent="toggleColorPicker"
          v-html="svg.textColor"
          :style="{ color: currentTextColor || undefined }"
        />
        <div
          v-if="colorPickerOpen"
          class="rich-dropdown absolute top-full left-0 mt-1 p-2 z-50"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div class="rich-color-grid">
            <button
              v-for="c in colorPalette"
              :key="c"
              class="rich-color-swatch"
              :style="{ backgroundColor: c }"
              :title="c"
              @mousedown.prevent="setTextColor(c)"
            />
          </div>
          <div
            class="rich-dropdown-item text-[11px] justify-center mt-1"
            @mousedown.prevent="setTextColor('')"
          >
            默认颜色
          </div>
        </div>
        <div v-if="colorPickerOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
      </div>

      <button title="高亮 Ctrl+G" :class="btnClass(active.highlight)" @mousedown.prevent="execHighlight" v-html="svg.highlighter" />
      <button v-if="editMode !== 'material'" title="插入批注" :class="btnClass(active.comment)" @mousedown.prevent="execComment" v-html="svg.comment" />
      <div v-if="editMode !== 'material'" class="relative inline-flex">
        <button
          title="校对：全文/选区标注错别字、标点、语法等（可在右侧面板处理）"
          :class="btnClass(proofreadActive)"
          :disabled="proofreadStore.loading"
          @mousedown.prevent="runProofreadAction"
          v-html="svg.proofread"
        />
        <span v-if="proofreadStore.loading" class="pf-btn-spinner" />
      </div>
      <button title="清除格式" class="rich-btn" @mousedown.prevent="execClearFormat" v-html="svg.clearFormat" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 段落样式 ── -->
      <div class="relative">
        <button
          title="段落样式 Ctrl+1~4"
          class="rich-btn min-w-[64px] flex items-center gap-0.5"
          @mousedown.prevent="toggleHeadingDropdown"
        >
          <span class="text-xs font-medium">{{ currentHeadingLabel }}</span>
          <span v-html="svg.chevronDown" class="flex items-center" :class="{ 'rotate-180': headingDropdownOpen }" />
        </button>
        <div
          v-if="headingDropdownOpen"
          class="rich-dropdown absolute top-full left-0 mt-1 w-36 py-1 z-50"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.paragraph }" @mousedown.prevent="execHeading(0)">
            <span class="text-xs leading-none" :style="previewBodyStyle">正文</span>
            <span class="text-[10px] opacity-50 shrink-0">{{ bodyFontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading1 }" @mousedown.prevent="execHeading(1)">
            <span class="leading-none" :style="previewH1Style">标题 1</span>
            <span class="text-[10px] opacity-50 shrink-0">Ctrl+1 / {{ h1FontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading2 }" @mousedown.prevent="execHeading(2)">
            <span class="leading-none" :style="previewH2Style">标题 2</span>
            <span class="text-[10px] opacity-50 shrink-0">Ctrl+2 / {{ h2FontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading3 }" @mousedown.prevent="execHeading(3)">
            <span class="leading-none" :style="previewH3Style">标题 3</span>
            <span class="text-[10px] opacity-50 shrink-0">Ctrl+3 / {{ h3FontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading4 }" @mousedown.prevent="execHeading(4)">
            <span class="leading-none" :style="previewH4Style">标题 4</span>
            <span class="text-[10px] opacity-50 shrink-0">Ctrl+4 / {{ h4FontSizePt }}pt</span>
          </div>
        </div>
        <div v-if="headingDropdownOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
      </div>

      <!-- ── 字体、字号（与文字样式同组） -->
      <div class="relative">
        <button
          class="rich-btn min-w-[100px] flex items-center gap-0.5 text-[11px]"
          @mousedown.prevent="toggleFontDropdown"
        >
          <span class="whitespace-nowrap" :style="{ fontFamily: fontFamily }">{{ fontFamilyLabel }}</span>
          <span v-html="svg.chevronDown" class="flex items-center shrink-0" :class="{ 'rotate-180': fontDropdownOpen }" />
        </button>
        <div
          v-if="fontDropdownOpen"
          class="rich-dropdown absolute top-full left-0 mt-1 w-44 py-1 z-50 max-h-48 overflow-y-auto"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div
            v-for="f in fontOptions"
            :key="f"
            class="rich-dropdown-item text-[12px]"
            :class="{ 'rich-dropdown-active': fontFamily === f }"
            :style="{ fontFamily: f }"
            @mousedown.prevent="setFontFamily(f); fontDropdownOpen = false"
          >
            {{ f }}
          </div>
        </div>
        <div v-if="fontDropdownOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
      </div>

      <div class="relative">
        <div class="relative">
          <button
            class="rich-btn min-w-[44px] flex items-center gap-0.5 text-[11px]"
            @mousedown.prevent="toggleFontSizeDropdown"
          >
            <span>{{ currentFontSizeLabel }}</span>
            <span v-html="svg.chevronDown" class="flex items-center" :class="{ 'rotate-180': fontSizeDropdownOpen }" />
          </button>
          <div
            v-if="fontSizeDropdownOpen"
            class="rich-dropdown absolute top-full left-0 mt-1 w-16 py-1 z-50"
            :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
            @click.stop
          >
            <div
              v-for="s in fontSizeMap"
              :key="s.label"
              class="rich-dropdown-item text-[11px] justify-center"
              :class="{ 'rich-dropdown-active': currentFontSizeLabel === s.label }"
              @mousedown.prevent="setFontSize(s.label); fontSizeDropdownOpen = false"
            >
              {{ s.label }}
            </div>
          </div>
        </div>
      </div>
      <div v-if="fontSizeDropdownOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 段落排列 ── -->
      <button title="左对齐" :class="btnClass(active.alignLeft)" @mousedown.prevent="execAlign('left')" v-html="svg.alignLeft" />
      <button title="居中" :class="btnClass(active.alignCenter)" @mousedown.prevent="execAlign('center')" v-html="svg.alignCenter" />
      <button title="右对齐" :class="btnClass(active.alignRight)" @mousedown.prevent="execAlign('right')" v-html="svg.alignRight" />
      <button title="两端对齐" :class="btnClass(active.alignJustify)" @mousedown.prevent="execAlign('justify')" v-html="svg.alignJustify" />

      <button title="减少缩进" class="rich-btn" @mousedown.prevent="execOutdent" v-html="svg.outdent" />
      <button title="增加缩进" class="rich-btn" @mousedown.prevent="execIndent" v-html="svg.indent" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 插入元素 ── -->
      <button title="分割线" class="rich-btn" @mousedown.prevent="execHr" v-html="svg.hr" />

      <div class="relative">
        <button title="插入表格" class="rich-btn" @mousedown.prevent="openTablePicker" v-html="svg.table" />
        <div
          v-if="tablePickerOpen"
          class="rich-table-picker absolute top-full left-0 mt-1 z-50 p-2"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div class="text-[10px] mb-1.5 text-center" :style="{ color: btnText }">
            {{ tablePickerRows }} × {{ tablePickerCols }} 表格
          </div>
          <div class="rich-table-grid">
            <template v-for="r in maxTableRows" :key="r">
              <div
                v-for="c in maxTableCols"
                :key="`${r}-${c}`"
                class="rich-table-cell"
                :class="{
                  'rich-table-cell-active': r <= tablePickerRows && c <= tablePickerCols,
                  'rich-table-cell-header': r === 1 && c <= tablePickerCols
                }"
                @mouseenter="tablePickerRows = r; tablePickerCols = c"
                @click="insertTableAt(r, c)"
              />
            </template>
          </div>
        </div>
        <div v-if="tablePickerOpen" class="fixed inset-0 z-40" @mousedown="closeTablePicker" />
      </div>

      <template v-if="isInTable">
        <button title="上方插入行" class="rich-btn" @mousedown.prevent="execAddRowBefore" v-html="svg.addRowAbove" />
        <button title="下方插入行" class="rich-btn" @mousedown.prevent="execAddRowAfter" v-html="svg.addRowBelow" />
        <button title="左侧插入列" class="rich-btn" @mousedown.prevent="execAddColumnBefore" v-html="svg.addColumnLeft" />
        <button title="右侧插入列" class="rich-btn" @mousedown.prevent="execAddColumnAfter" v-html="svg.addColumnRight" />
        <button title="删除行" class="rich-btn" @mousedown.prevent="execDeleteRow" v-html="svg.deleteRow" />
        <button title="删除列" class="rich-btn" @mousedown.prevent="execDeleteColumn" v-html="svg.deleteColumn" />
        <button title="删除表格" class="rich-btn" @mousedown.prevent="execDeleteTable" v-html="svg.deleteTable" />
        <button
          title="合并单元格（先 Ctrl+点击 选中多个单元格）"
          class="rich-btn"
          :class="{ 'rich-btn-active': isCellSelection }"
          :disabled="!canMergeCells"
          :style="{ opacity: canMergeCells ? 1 : 0.35, cursor: canMergeCells ? 'pointer' : 'default' }"
          @mousedown.prevent="execMergeCells"
          v-html="svg.mergeCells"
        />
        <button
          title="拆分单元格"
          class="rich-btn"
          :disabled="!canSplitCell"
          :style="{ opacity: canSplitCell ? 1 : 0.35, cursor: canSplitCell ? 'pointer' : 'default' }"
          @mousedown.prevent="execSplitCell"
          v-html="svg.splitCell"
        />
        <button
          title="切换标题行/列"
          class="rich-btn"
          @mousedown.prevent="execToggleHeaderRow"
          v-html="svg.toggleHeader"
        />
      </template>

      <button title="插入图片" class="rich-btn" @mousedown.prevent="execImage" v-html="svg.image" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- ── 文档工具 ── -->
      <button title="查找替换 Ctrl+F" class="rich-btn" :class="{ 'rich-btn-active': searchOpen }" @mousedown.prevent="toggleSearch" v-html="svg.search" />
      <button title="打印文档" class="rich-btn" @click="printDocument" v-html="svg.printer" />
      <div class="relative">
        <button title="插入符号" class="rich-btn" :class="{ 'rich-btn-active': symbolPanelOpen }" @mousedown.prevent="toggleSymbolPanel" v-html="svg.symbol" />
        <div
          v-if="symbolPanelOpen"
          class="rich-dropdown absolute top-full left-0 mt-1 p-1.5 z-50"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder, display: 'grid', gridTemplateColumns: 'repeat(4, 30px)', gap: '4px' }"
          @click.stop
        >
          <button
            v-for="ch in SYMBOLS"
            :key="ch"
            class="symbol-cell"
            @mousedown.prevent="insertSymbol(ch)"
          >{{ ch }}</button>
        </div>
      </div>
      <div v-if="symbolPanelOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />

      <button title="修正引号：直引号 &quot; → 中文弯引号 “ ”（选中则处理选区，否则处理全文）" class="rich-btn" @mousedown.prevent="fixCurlyQuotes" v-html="svg.quoteFix" />

      <div class="flex-1" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 页面缩放控制 -->
      <button title="页面缩小 Ctrl+滚轮↓" class="rich-btn" @mousedown.prevent="zoomOut" v-html="svg.minus" />
      <span class="text-[11px] font-medium tabular-nums select-none min-w-[34px] text-center" :style="{ color: btnText }">{{ zoomPercent }}%</span>
      <button title="页面放大 Ctrl+滚轮↑" class="rich-btn" @mousedown.prevent="zoomIn" v-html="svg.plus" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 全屏模式 -->
      <button title="全屏模式" class="rich-btn" @mousedown.prevent="emit('toggle-fullscreen')" v-html="svg.fullscreen" />

    </div>

    <!-- 查找替换面板 -->
    <div
      v-if="searchOpen"
      class="rich-search-panel flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0"
      :style="{ backgroundColor: tbBg, borderColor: tbBorder }"
    >
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        type="text"
        placeholder="查找..."
        class="rich-search-input text-[11px] px-2 py-1 rounded outline-none"
        :style="{
          backgroundColor: contentBg,
          color: contentText,
          border: `1px solid ${tbBorder}`,
          width: '160px'
        }"
        @input="debouncedSearch"
        @keydown.enter="debouncedSearch.cancel(); doSearch()"
      />
      <input
        v-model="replaceQuery"
        type="text"
        placeholder="替换为..."
        class="rich-search-input text-[11px] px-2 py-1 rounded outline-none"
        :style="{
          backgroundColor: contentBg,
          color: contentText,
          border: `1px solid ${tbBorder}`,
          width: '140px'
        }"
        @keydown.enter="doSearch"
      />
      <button
        class="rich-search-btn text-[10px] font-bold"
        :class="{ 'rich-btn-active': caseSensitive }"
        title="区分大小写"
        @click="caseSensitive = !caseSensitive; doSearch()"
      >Aa</button>
      <span class="text-[10px] shrink-0" :style="{ color: btnText }" v-if="searchCount > 0">
        {{ searchIdx }}/{{ searchCount }}
      </span>
      <button class="rich-search-btn text-[10px]" @click="prevResult" :disabled="searchCount === 0">◀</button>
      <button class="rich-search-btn text-[10px]" @click="nextResult" :disabled="searchCount === 0">▶</button>
      <button class="rich-search-btn text-[10px]" @click="doReplace" :disabled="searchCount === 0">替换</button>
      <button class="rich-search-btn text-[10px]" @click="doReplaceAll" :disabled="searchCount === 0">全部替换</button>
      <div class="flex-1" />
      <button class="rich-search-btn text-[10px]" @click="toggleSearch" v-html="svg.close" />
    </div>

    <!-- Body: outline panel + editor -->
    <div class="flex flex-1 min-h-0 relative overflow-hidden">
      <slot name="overlay" />
      <!-- 大纲导航面板 -->
      <div
        v-if="showOutline"
        class="rich-outline shrink-0 flex flex-col border-r overflow-hidden"
        :class="{ 'select-none': isResizingOutline }"
        :style="{ backgroundColor: tbBg, borderColor: tbBorder, width: outlineWidth + 'px' }"
      >
        <div class="flex items-center justify-between px-2.5 py-1.5 border-b shrink-0" :style="{ borderColor: tbBorder }">
          <span class="text-[11px] font-semibold" :style="{ color: btnText }">大纲导航</span>
          <button class="flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors" @mousedown.prevent="showOutline = false">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" :stroke="btnText" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto py-1">
          <div v-if="headings.length === 0" class="px-3 py-4 text-center text-[11px] opacity-40" :style="{ color: btnText }">
            暂无标题<br/>使用标题样式（H1-H4）<br/>将自动出现在这里
          </div>
          <div
            v-for="(h, i) in headings"
            :key="i"
            class="outline-item flex items-center gap-1 px-2.5 py-1 cursor-pointer text-[12px] leading-snug transition-colors select-none truncate"
            :class="{
              'outline-lv1': h.level === 1,
              'outline-lv2': h.level === 2,
              'outline-lv3': h.level === 3,
              'outline-lv4': h.level === 4,
            }"
            :style="{
              paddingLeft: (8 + (h.level - 1) * 14) + 'px',
              color: h.level <= 2 ? btnText : cardMetaColor,
              fontWeight: h.level === 1 ? 600 : 400,
            }"
            :title="h.text"
            @mousedown.prevent="scrollToHeading(h.pos)"
          >
            {{ h.text || '(空标题)' }}
          </div>
        </div>
      </div>

      <!-- 拉伸分隔条 -->
      <div
        v-if="showOutline"
        class="shrink-0 w-[3px] cursor-col-resize"
        @mousedown="startResizeOutline"
      />

      <!-- 校对进度浮层（loading 时显示，绝对定位不占布局空间） -->
      <div v-if="proofreadStore.manualRun" class="proofread-loading-toast">
        <span class="pf-spinner" />
        <span>校对进行中…</span>
        <span class="pf-stop-btn" @click="proofreadStore.cancelProofread()" title="停止校对">停止</span>
      </div>
      <!-- 校对无问题提示（手动校对返回 0 问题时显示，约 2.5 秒后自动销毁） -->
      <div v-else-if="proofreadStore.cleanHint" class="proofread-clean-toast">
        <span>✅ 未发现问题</span>
      </div>
      <!-- 引号修正结果提示（约 2.5 秒后自动销毁） -->
      <div v-if="quoteFixMsg" class="proofread-clean-toast">
        <span>{{ quoteFixMsg }}</span>
      </div>

      <!-- 素材卡片视图：纸卡外壳 + 头部操作栏 -->
      <template v-if="editMode === 'material'">
        <!-- materialScroll=true: 单素材视图，自带滚动容器；false: 内嵌到外部多卡片列表 -->
        <div :class="materialScroll ? 'material-card-scroll flex-1 min-h-0 overflow-y-auto' : 'contents'">
          <div class="material-card">
            <div class="material-card-head">
              <div class="material-card-titles">
                <div class="material-card-title" :title="materialTitle">{{ materialTitle || '素材' }}</div>
                <div v-if="materialSource || materialTime" class="material-card-source" :title="materialSource">
                  <span
                    v-if="materialSource"
                    class="material-card-link"
                    @click="emit('open-browser', materialSource)"
                  >🔗 {{ materialSource }}</span>
                  <span v-if="materialTime" class="material-card-time">🕒 {{ materialTime }}</span>
                </div>
              </div>
              <div class="material-card-actions">
                <button v-if="noteMaterialId" class="mc-btn" title="给这张素材卡片写碎念" @click="openNoteInput">💭 碎念</button>
                <button class="mc-btn" title="复制素材内容（有选区则复制选区）" @mousedown.prevent="onCardCopy">📋 复制</button>
                <button v-if="inTag" class="mc-btn" title="从当前标签移除该素材" @mousedown.prevent="onCardRemoveFromTag">⬅ 从此标签移除</button>
                <button class="mc-btn mc-btn-danger" title="从素材库删除该素材" @mousedown.prevent="onCardDelete">🗑 删除</button>
              </div>
            </div>
            <EditorContent :editor="editor" class="rich-content material-card-body" :style="{ color: contentText }" />
            <MaterialNoteBox
              v-if="noteMaterialId"
              ref="noteBoxRef"
              :material-id="noteMaterialId"
            />
          </div>
        </div>
      </template>

      <!-- 文档/其他视图：原生编辑区 -->
      <template v-else>
        <EditorContent :editor="editor" class="flex-1 overflow-y-auto rich-content" :style="{ color: contentText }" />
      </template>

      <!-- 批注面板：文档模式 + 单素材视图此处渲染；tag view 由 EditorView 外层统一挂载 -->
      <CommentListPanel
        v-if="editMode !== 'material' || materialScroll"
        @jump="onCommentListJump"
        @jumpProofread="onProofreadJump"
        @replaceProofread="onProofreadReplace"
      />
    </div>

    <!-- 批注输入浮层 -->
    <CommentInputBar
      v-if="commentBarVisible"
      :position="commentBarPosition"
      @confirm="onCommentConfirm"
      @cancel="onCommentCancel"
    />

    <!-- 批注 hover 浮层 -->
    <CommentTooltip ref="tooltipRef" />

    <!-- 校对 hover 浮层 -->
    <div
      v-if="proofreadTip.show && proofreadTip.issue"
      class="proofread-tip"
      :style="{ left: proofreadTip.x + 'px', top: proofreadTip.y + 'px' }"
    >
      <div>
        <span class="pf-cat">{{ proofreadTip.issue.category }}</span>
        <span class="pf-old">{{ proofreadTip.issue.original }}</span> →
        <span class="pf-new">{{ proofreadTip.issue.suggestion }}</span>
      </div>
      <div v-if="proofreadTip.issue.reason" style="margin-top: 4px; opacity: 0.8">{{ proofreadTip.issue.reason }}</div>
    </div>

    <!-- 工具栏轻量提示 -->
    <div v-if="toolbarHint" class="rich-toolbar-hint">{{ toolbarHint }}</div>

    <!-- 右键菜单 (Teleport to body) -->
    <Teleport to="body">
    <div
      v-if="ctxMenuShow"
      class="ctx-menu"
      :style="{ left: ctxMenuX + 'px', top: ctxMenuY + 'px' }"
    >
      <!-- 文档模式菜单 -->
      <template v-if="!editMode || editMode === 'document'">
        <div class="ctx-menu-item" @click.stop="execCtxMenuCut">
          <span>剪切</span><span class="ctx-shortcut">Ctrl+X</span>
        </div>
        <div class="ctx-menu-item" @click.stop="execCtxMenuCopy">
          <span>复制</span><span class="ctx-shortcut">Ctrl+C</span>
        </div>
        <div class="ctx-menu-item" @click.stop="execCtxMenuPaste">
          <span>粘贴</span><span class="ctx-shortcut">Ctrl+V</span>
        </div>
        <template v-if="ctxMenuSelText">
          <div class="ctx-separator" />
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddToChat">
            <span>💬 添加到 AI 对话</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddToCandidate">
            <span>📋 添加到候选库</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuClip">
            <span>📦 存入素材库</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddComment">
            <span>📍 插入批注</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddToCompare">
            <span>↔️ 加入比对</span><span class="ctx-shortcut" />
          </div>
        </template>
      </template>
      <!-- 素材模式菜单 -->
      <template v-if="editMode === 'material'">
        <div class="ctx-menu-item" @click.stop="execCtxMenuCopy">
          <span>复制</span><span class="ctx-shortcut">Ctrl+C</span>
        </div>
        <template v-if="ctxMenuSelText">
          <div class="ctx-separator" />
          <div class="ctx-menu-item" @click.stop="execCtxMenuInsertToChat">
            <span>💬 添加到 AI 对话</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddToCandidate">
            <span>📋 添加到候选库</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddToCompare">
            <span>↔️ 加入比对</span><span class="ctx-shortcut" />
          </div>
        </template>
        <div class="ctx-separator" />
        <!-- 单素材视图：直接删除 -->
        <template v-if="materialId">
          <div class="ctx-menu-item ctx-menu-item-danger" @click.stop="execCtxMenuDeleteMaterial">
            <span>🗑 删除素材</span><span class="ctx-shortcut" />
          </div>
        </template>
        <!-- 标签视图：需选中文本才能操作 -->
        <template v-else-if="ctxMenuSelText">
          <div class="ctx-menu-item ctx-menu-item-danger" @click.stop="execCtxMenuRemoveFromTag">
            <span>🔗 从此标签中移除</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item ctx-menu-item-danger" @click.stop="execCtxMenuDeleteMaterial">
            <span>🗑 从素材库中删除</span><span class="ctx-shortcut" />
          </div>
        </template>
      </template>
    </div>
    <!-- 透明遮罩，点击任意处关闭菜单 -->
    <div v-if="ctxMenuShow" class="ctx-overlay" @mousedown="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
  </Teleport>

    <!-- 素材选中悬浮工具条 (Teleport to body，ima 风格) -->
    <Teleport to="body">
      <div
        v-if="matTbShow && editMode === 'material'"
        ref="matToolbarRef"
        class="mat-float-toolbar"
        :class="{ 'is-dark': isDark }"
        :style="{ left: matTbX + 'px', top: matTbY + 'px', visibility: matTbPositioned ? 'visible' : 'hidden' }"
        @mousedown.prevent
        @contextmenu.prevent
      >
        <div class="mat-tb-btn" @click.stop="matCopy">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>复制</span>
        </div>
        <div class="mat-tb-btn" @click.stop="matChat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>对话</span>
        </div>
        <div class="mat-tb-btn" @click.stop="matCandidate">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="4.5" cy="18" r="1.3"/></svg>
          <span>候选</span>
        </div>
        <div class="mat-tb-btn" @click.stop="matCompare">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 3 21 7 17 11"/><path d="M21 7H8"/><polyline points="7 21 3 17 7 13"/><path d="M3 17h13"/></svg>
          <span>比对</span>
        </div>
        <!-- 笔记按钮 + 下拉面板（hover 触发） -->
        <div class="mat-tb-btn" style="position:relative;"
          @mouseenter="matNoteShow = true"
          @mouseleave="matNoteScheduleHide"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.17 2H2.83A.83.83 0 0 0 2 2.83v16.34c0 .46.37.83.83.83H12l10-10V2.83a.83.83 0 0 0-.83-.83z"/><path d="M12 2v8h8"/></svg>
          <span>笔记</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :style="{ transform: matNoteShow ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }"><polyline points="6 9 12 15 18 9"/></svg>
          <!-- 笔记下拉面板 -->
          <div v-if="matNoteShow" ref="matNoteDropdownRef"
            class="mat-note-dropdown" :class="{ 'is-dark': isDark }"
            @mouseenter="matNoteCancelHide"
            @mouseleave="matNoteScheduleHide"
            @click.stop
          >
            <div class="mat-note-item" @click.stop="matNoteCreateNew">
              <span style="font-size:15px;">📝</span>
              <span>新建笔记</span>
            </div>
            <div class="mat-note-divider" />
            <div v-if="matNoteDocList.length > 0" class="mat-note-section-header">追加到文档</div>
            <div v-for="doc in matNoteDocList" :key="doc.id" class="mat-note-item mat-note-doc-item" @click.stop="matNoteAppendToDoc(doc.id)">
              {{ doc.title }}
            </div>
            <div v-if="matNoteDocList.length === 0" class="mat-note-empty">暂无文档，请先创建</div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* ── 主题自适应色彩变量 ── */
:root {
  --ae-placeholder: #9ca3af;
  --ae-blockquote-text: #4b5563;
  --ae-pre-bg: rgba(0,0,0,0.05);
  --ae-code-bg: rgba(0,0,0,0.04);
  --ae-img-shadow: 0 1px 4px rgba(0,0,0,0.05);
  --ae-dropdown-shadow: 0 4px 16px rgba(0,0,0,0.08);
  --ae-ctxmenu-shadow: 0 8px 24px rgba(0,0,0,0.08);
  --ae-ctxmenu-danger-hover: rgba(239,68,68,0.06);
  --ae-swatch-border: rgba(0,0,0,0.08);
  --ae-mark-bg: rgba(251,191,36,0.35);
  --ae-search-bg: rgba(255,193,7,0.3);
  --ae-search-shadow: 0 0 0 1px rgba(255,193,7,0.22);

  /* 以下在浅/深主题中表现一致 */
  --ae-blockquote-border: #3b82f6;
  --ae-link: #3b82f6;
  --ae-img-sel-outline: rgba(59,130,246,0.7);
  --ae-img-sel-shadow: 0 0 0 4px rgba(59,130,246,0.15), 0 2px 8px rgba(0,0,0,0.1);
  --ae-cell-sel-bg: rgba(59,130,246,0.18);
  --ae-cell-sel-outline: rgba(59,130,246,0.45);
  --ae-cell-sel-after: rgba(59,130,246,0.06);
  --ae-diff-bg: linear-gradient(180deg, rgba(250,204,21,0.35) 0%, rgba(250,204,21,0.55) 100%);
  --ae-diff-border: rgba(234,179,8,0.9);
  --ae-swatch-hover: 0 0 0 2px rgba(59,130,246,0.35);
  --ae-ctxmenu-danger: #ef4444;
  --ae-search-focus-border: #3b82f6;
  --ae-table-cell-active-bg: rgba(59,130,246,0.25);
  --ae-table-cell-active-border: rgba(59,130,246,0.5);
  --ae-table-cell-header-bg: rgba(59,130,246,0.15);
  --ae-column-resize: rgba(59,130,246,0.4);
}
.dark {
  --ae-placeholder: #555973;
  --ae-blockquote-text: #a4abc0;
  --ae-pre-bg: rgba(0,0,0,0.22);
  --ae-code-bg: rgba(0,0,0,0.16);
  --ae-img-shadow: 0 1px 6px rgba(0,0,0,0.25);
  --ae-dropdown-shadow: 0 8px 28px rgba(0,0,0,0.5);
  --ae-ctxmenu-shadow: 0 12px 36px rgba(0,0,0,0.6);
  --ae-ctxmenu-danger-hover: rgba(239,68,68,0.18);
  --ae-swatch-border: rgba(255,255,255,0.06);
  --ae-mark-bg: rgba(251,191,36,0.22);
  --ae-search-bg: rgba(255,193,7,0.32);
  --ae-search-shadow: 0 0 0 1px rgba(255,193,7,0.38);
}

/* ── 编辑器内容区 ── */
.rich-content .ProseMirror {
  --apz: v-bind(pageZoom); /* 页面缩放因子：与 CSS 层字号和 mark 层 inline 字号联动 */
  min-height: 100%;
  padding: 1rem 1.5rem;
  outline: none;
  font-size: calc(v-bind(bodyFontSizePt) * 1pt * var(--apz));
  font-family: v-bind(bodyFontFamily), 'Microsoft YaHei', sans-serif;
  line-height: v-bind(bodyLineHeight);
  text-align: justify;
  caret-color: #1a1a1a !important;
  /* ★ 自绘 I-beam 光标（绕开 WebView2 系统指针位图缓存 bug）
     画布 20×24：竖条 y=2..22，上下短横在 y=2 / y=22（端点对齐）
     白色外描边 + 黑色主体，热点 (10, 12) = I-beam 中心 */
  cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='24' viewBox='0 0 20 24'><line x1='10' y1='2' x2='10' y2='22' stroke='white' stroke-width='3'/><line x1='10' y1='2' x2='10' y2='22' stroke='black' stroke-width='1.5'/><line x1='5' y1='2' x2='15' y2='2' stroke='white' stroke-width='2.5'/><line x1='5' y1='2' x2='15' y2='2' stroke='black' stroke-width='1.2'/><line x1='5' y1='22' x2='15' y2='22' stroke='white' stroke-width='2.5'/><line x1='5' y1='22' x2='15' y2='22' stroke='black' stroke-width='1.2'/></svg>") 10 12, text;
}
.dark .rich-content .ProseMirror {
  caret-color: #cdd6f4 !important;
  /* 深色模式：白色竖线 + 黑色描边 */
  cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='24' viewBox='0 0 20 24'><line x1='10' y1='2' x2='10' y2='22' stroke='%2314151d' stroke-width='3'/><line x1='10' y1='2' x2='10' y2='22' stroke='%23cdd6f4' stroke-width='1.5'/><line x1='5' y1='2' x2='15' y2='2' stroke='%2314151d' stroke-width='2.5'/><line x1='5' y1='2' x2='15' y2='2' stroke='%23cdd6f4' stroke-width='1.2'/><line x1='5' y1='22' x2='15' y2='22' stroke='%2314151d' stroke-width='2.5'/><line x1='5' y1='22' x2='15' y2='22' stroke='%23cdd6f4' stroke-width='1.2'/></svg>") 10 12, text;
}
.rich-content .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  color: var(--ae-placeholder);
  pointer-events: none;
  height: 0;
}
.rich-content .ProseMirror h1 { font-family: v-bind(h1FontFamily); font-size: calc(v-bind(h1FontSizePt) * 1pt * var(--apz)); line-height: v-bind(h1LineHeight); font-weight: v-bind(h1FontWeight); margin: 0.67em 0; }
.rich-content .ProseMirror h2 { font-family: v-bind(h2FontFamily); font-size: calc(v-bind(h2FontSizePt) * 1pt * var(--apz)); line-height: v-bind(h2LineHeight); font-weight: v-bind(h2FontWeight); margin: 0.6em 0; }
.rich-content .ProseMirror h3 { font-family: v-bind(h3FontFamily); font-size: calc(v-bind(h3FontSizePt) * 1pt * var(--apz)); line-height: v-bind(h3LineHeight); font-weight: v-bind(h3FontWeight); margin: 0.5em 0; }
.rich-content .ProseMirror h4 { font-family: v-bind(h4FontFamily); font-size: calc(v-bind(h4FontSizePt) * 1pt * var(--apz)); line-height: v-bind(h4LineHeight); font-weight: v-bind(h4FontWeight); margin: 0.4em 0; }
.rich-content .ProseMirror blockquote {
  border-left: 3px solid var(--ae-blockquote-border);
  padding-left: 1em;
  margin: 0.5em 0;
  color: var(--ae-blockquote-text);
}
.rich-content .ProseMirror pre {
  background: var(--ae-pre-bg);
  padding: 0.75em 1em;
  border-radius: 4px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.9em;
  overflow-x: auto;
}
.rich-content .ProseMirror code {
  background: var(--ae-code-bg);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.9em;
}
.rich-content .ProseMirror ul,
.rich-content .ProseMirror ol { padding-left: 1.5em; margin: 0.3em 0; }
.rich-content .ProseMirror li { margin: 0.15em 0; }
.rich-content .ProseMirror hr { border: none; border-top: 1px solid; margin: 1em 0; opacity: 0.3; }
.rich-content .ProseMirror img {
  display: block;
  max-width: 100%;
  width: auto;
  height: auto;
  border-radius: 4px;
  margin: 0.75em auto;
  box-shadow: var(--ae-img-shadow);
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.15s;
}
/* 图片被选中时（点击选中）的蓝色高亮 */
.rich-content .ProseMirror img.ProseMirror-selectednode,
.rich-content .ProseMirror .ProseMirror-selectednode img {
  outline-color: var(--ae-img-sel-outline);
  box-shadow: var(--ae-img-sel-shadow);
  border-radius: 4px;
}
.rich-content .ProseMirror table { border-collapse: collapse; margin: 0.5em 0; width: 100%; table-layout: fixed; }
.rich-content .ProseMirror th,
.rich-content .ProseMirror td { border: 1px solid; padding: 0.4em 0.6em; text-align: left; overflow-wrap: break-word; word-break: break-word; }
.rich-content .ProseMirror th { font-weight: 600; }
/* 表格单元格选中高亮（Ctrl/Cmd+点击选中单元格时） */
.rich-content .ProseMirror .selectedCell {
  background: var(--ae-cell-sel-bg);
  outline: 2px solid var(--ae-cell-sel-outline);
  outline-offset: -1px;
  position: relative;
}
.rich-content .ProseMirror .selectedCell::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ae-cell-sel-after);
  pointer-events: none;
}
.rich-content .ProseMirror a { color: var(--ae-link); text-decoration: underline; cursor: pointer; }
.rich-content .ProseMirror s { text-decoration: line-through; opacity: 0.7; }
.rich-content .ProseMirror mark { background: var(--ae-mark-bg); padding: 0 2px; border-radius: 2px; }
.rich-content .ProseMirror p { margin: 0.3em 0; }

/* ── 素材卡片视图 ── */
/* 滚动容器（替代原 .rich-content 的 overflow） */
.material-card-scroll {
  padding: 22px 14px 44px;
}
/* 纸卡本体 */
.material-card {
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  background: #ffffff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 14px;
  box-shadow: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: border-color 0.2s ease;
}
.material-card:hover {
  border-color: rgba(99, 102, 241, 0.45);
}
.dark .material-card {
  background: #1c1f2e;
  border-color: rgba(255, 255, 255, 0.09);
  box-shadow: none;
}
.dark .material-card:hover {
  border-color: rgba(137, 180, 250, 0.5);
}
/* 卡片头部（标题 + 来源 + 操作） */
.material-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 16px 12px 20px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  background: linear-gradient(180deg, rgba(99, 102, 241, 0.06), rgba(99, 102, 241, 0));
}
.dark .material-card-head {
  border-bottom-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(137, 180, 250, 0.07), rgba(137, 180, 250, 0));
}
.material-card-titles { min-width: 0; }
.material-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dark .material-card-title { color: #cdd6f4; }
.material-card-source {
  margin-top: 3px;
  font-size: 11px;
  color: #94a3b8;
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  overflow: hidden;
}
.material-card-source > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.material-card-link {
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s ease;
}
.material-card-link:hover {
  color: #6366f1;
  text-decoration: underline;
}
.dark .material-card-link:hover {
  color: #89b4fa;
}
.material-card-time { flex-shrink: 0; }
.dark .material-card-source { color: #7f849c; }
.material-card-actions { display: flex; gap: 6px; flex-shrink: 0; }
.mc-btn {
  font-size: 11px;
  line-height: 1;
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #ffffff;
  color: #475569;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.mc-btn:hover { background: #f1f5f9; color: #1e293b; border-color: rgba(15, 23, 42, 0.18); }
.dark .mc-btn { background: #262a3b; border-color: rgba(255, 255, 255, 0.1); color: #cdd6f4; }
.dark .mc-btn:hover { background: #313650; color: #f8fafc; }
.mc-btn-danger:hover { background: #fef2f2; color: #dc2626; border-color: rgba(220, 38, 38, 0.3); }
.dark .mc-btn-danger:hover { background: #3b2326; color: #f87171; border-color: rgba(248, 113, 113, 0.4); }

/* 正文区：宽度/居中由卡片容器控制，这里只负责内边距与字体 */
.rich-editor-wrapper.is-material .ProseMirror {
  font-family: var(--mat-font-family, 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif);
  font-size: var(--mat-font-size, 16px);
  line-height: 1.85;
  padding: 1.5rem 2rem;
}

/* 标签多卡片列表（父级滚动，每张素材一个内嵌卡片） */
.material-list-scroll { padding: 0; }
.material-list-inner {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 14px 44px;
  max-width: 920px;
  margin: 0 auto;
}
/* 内嵌卡片：取消 RichEditor 根节点的 100% 高度，改为按内容自适应，并强制占满列表宽度 */
.material-card-host.rich-editor-wrapper { height: auto; width: 100%; align-self: stretch; }
/* 卡片标题 h2 */
.rich-editor-wrapper.is-material .ProseMirror h2 {
  font-size: 1.05em;
  font-weight: 700;
  margin: 1.6em 0 0.7em 0;
  padding: 0.55em 0.8em;
  background: v-bind(cardTitleBg);
  border-left: 3.5px solid v-bind(cardAccent);
  border-radius: 0 8px 8px 0;
  color: v-bind(cardAccent);
  letter-spacing: 0.02em;
}
.rich-editor-wrapper.is-material .ProseMirror h2:first-child {
  margin-top: 0.2em;
}
/* 素材间分隔线 */
.rich-editor-wrapper.is-material .ProseMirror hr {
  border: none;
  height: 2px;
  background: v-bind(cardDivider);
  margin: 1.8em 0;
  opacity: 1;
}
/* 元信息（斜体文本） */
.rich-editor-wrapper.is-material .ProseMirror em {
  font-style: normal;
  font-size: 0.82em;
  color: v-bind(cardMetaColor);
  display: inline-block;
  padding: 0.25em 0.55em;
  background: v-bind(metaBg);
  border-radius: 4px;
  letter-spacing: 0.01em;
}

/* ── Diff 回放高亮 ── */
.rich-content .ProseMirror .diff-change-highlight {
  background: var(--ae-diff-bg);
  border-bottom: 2px solid var(--ae-diff-border);
  padding: 1px 2px;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(234,179,8,0.35), 0 0 8px rgba(250,204,21,0.45);
  transition: background 120ms ease-out;
}
/* 高亮内的 mark 保留原样式 */
.rich-content .ProseMirror .diff-change-highlight mark {
  background: inherit;
}

/* ── 搜索高亮 ── */
.rich-content .ProseMirror .search-highlight {
  background: var(--ae-search-bg);
  border-radius: 2px;
  box-shadow: var(--ae-search-shadow);
}

/* ── 校对波浪线 ── */
.rich-content .ProseMirror .proofread-underline {
  text-decoration: underline wavy #ef4444;
  text-decoration-skip-ink: none;
  text-underline-offset: 2px;
}
.dark .rich-content .ProseMirror .proofread-underline {
  text-decoration-color: #f87171;
}

/* ── 校对进度浮层（绝对定位，不占布局空间） ── */
.proofread-loading-toast {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: #374151;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(239, 68, 68, 0.35);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  pointer-events: none;
  backdrop-filter: blur(2px);
}
.dark .proofread-loading-toast {
  color: #e5e7eb;
  background: rgba(31, 41, 55, 0.92);
  border-color: rgba(248, 113, 113, 0.45);
}
/* 校对无问题提示（绿色，2.5 秒后自动消失） */
.proofread-clean-toast {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: #065f46;
  background: rgba(236, 253, 245, 0.95);
  border: 1px solid rgba(16, 185, 129, 0.4);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  pointer-events: none;
  backdrop-filter: blur(2px);
  animation: pf-clean-in 0.18s ease-out;
}
@keyframes pf-clean-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
.dark .proofread-clean-toast {
  color: #6ee7b7;
  background: rgba(6, 78, 59, 0.92);
  border-color: rgba(16, 185, 129, 0.5);
}
/* 旋转指示器 */
.pf-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(239, 68, 68, 0.3);
  border-top-color: #ef4444;
  border-radius: 50%;
  animation: pf-spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes pf-spin {
  to { transform: rotate(360deg); }
}
/* 停止校对按钮（下划线链接风格，需覆盖 toast 的 pointer-events:none） */
.pf-stop-btn {
  pointer-events: auto;
  cursor: pointer;
  text-decoration: underline;
  color: #ef4444;
  font-weight: 600;
  user-select: none;
  transition: color 0.15s;
}
.pf-stop-btn:hover {
  color: #dc2626;
}
.dark .pf-stop-btn {
  color: #f87171;
}
.dark .pf-stop-btn:hover {
  color: #fca5a5;
}
/* 按钮上叠加的旋转图标（不占空间） */
.pf-btn-spinner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.pf-btn-spinner::after {
  content: "";
  width: 12px;
  height: 12px;
  border: 2px solid rgba(239, 68, 68, 0.35);
  border-top-color: #ef4444;
  border-radius: 50%;
  animation: pf-spin 0.7s linear infinite;
}
/* ── 校对 hover 浮层 ── */
.proofread-tip {
  position: fixed;
  z-index: 1000;
  max-width: 280px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #1f2937;
  background: #fff;
  border: 1px solid #fecaca;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
  pointer-events: none;
}
.dark .proofread-tip {
  color: #e5e7eb;
  background: #1f2937;
  border-color: #7f1d1d;
}
.proofread-tip .pf-cat { color: #ef4444; font-weight: 600; margin-right: 4px; }
.proofread-tip .pf-old { text-decoration: line-through; opacity: 0.7; }
.proofread-tip .pf-new { color: #059669; font-weight: 600; }
.dark .proofread-tip .pf-new { color: #34d399; }

/* ── 工具栏按钮 ── */
.rich-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  width: 26px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  background: transparent;
  color: v-bind(btnText);
  transition: background 0.15s, color 0.15s;
}
.rich-btn:hover {
  background: v-bind(btnHoverBg);
}
.rich-btn-active {
  background: v-bind(btnActiveBg) !important;
  color: v-bind(btnActiveText) !important;
}

/* ── 分隔符 ── */
.rich-sep {
  display: inline-block;
  width: 1px;
  height: 16px;
  margin: 0 3px;
}

/* ── 下拉菜单 ── */
.rich-dropdown {
  position: absolute;
  border: 1px solid;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.symbol-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 3px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: v-bind(btnText);
  transition: background 0.1s;
}
.symbol-cell:hover {
  background: v-bind(ddHoverBg);
}
.rich-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 0.1s;
  color: v-bind(dropdownItemColor);
}
.rich-dropdown-item:hover {
  background: v-bind(ddHoverBg);
}
.rich-dropdown-active {
  background: v-bind(btnActiveBg);
  color: v-bind(btnActiveText);
}

/* ── 颜色选择器 ── */
.rich-color-grid {
  display: grid;
  grid-template-columns: repeat(5, 20px);
  gap: 6px;
}
.rich-color-swatch {
  width: 20px;
  height: 20px;
  border-radius: 3px;
  border: 1px solid rgba(0,0,0,0.12);
  cursor: pointer;
  padding: 0;
  transition: transform 0.1s, box-shadow 0.1s;
}
.rich-color-swatch:hover {
  transform: scale(1.1);
  box-shadow: var(--ae-swatch-hover);
  z-index: 1;
}

/* ── 批注：下划虚线 + 角标 ── */
.rich-content span[data-comment-id],
.rich-content .comment-mark {
  text-decoration: underline dashed !important;
  text-decoration-color: #f59e0b !important;
  text-decoration-thickness: 1.5px !important;
  text-underline-offset: 3px !important;
  cursor: help;
  transition: background-color 0.12s;
}
.rich-content span[data-comment-id]:hover,
.rich-content .comment-mark:hover {
  background-color: rgba(245, 158, 11, 0.12);
}
.dark .rich-content span[data-comment-id]:hover,
.dark .rich-content .comment-mark:hover {
  background-color: rgba(251, 191, 36, 0.18);
}
.rich-content .comment-badge {
  color: #b45309;
  font-size: 0.7em;
  font-weight: 600;
  cursor: help;
  margin-left: 1px;
  user-select: none;
  -webkit-user-select: none;
  background: rgba(245, 158, 11, 0.12);
  padding: 0 2px;
  border-radius: 2px;
  transition: background-color 0.12s;
}
.rich-content .comment-badge:hover {
  background: rgba(245, 158, 11, 0.25);
}
.dark .rich-content .comment-badge {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.15);
}
.dark .rich-content .comment-badge:hover {
  background: rgba(251, 191, 36, 0.28);
}

/* ── 工具栏轻量提示 ── */
.rich-toolbar-hint {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  padding: 6px 12px;
  background: #1f2937;
  color: #fff;
  font-size: 12px;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  pointer-events: none;
  animation: rich-toolbar-hint-fade 0.2s ease-out;
}
.dark .rich-toolbar-hint {
  background: #f3f4f6;
  color: #1f2937;
}
@keyframes rich-toolbar-hint-fade {
  from { opacity: 0; transform: translate(-50%, -4px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

/* ── 右键菜单 ── */
.ctx-menu {
  position: fixed;
  z-index: 10000;
  background: v-bind(ddBg);
  border: 1px solid v-bind(ddBorder);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 200px;
  box-shadow: var(--ae-ctxmenu-shadow);
  font-size: 12px;
}
.ctx-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 12px;
  cursor: pointer;
  color: v-bind(dropdownItemColor);
  transition: background 0.1s;
}
.ctx-menu-item:hover {
  background: v-bind(ddHoverBg);
}
.ctx-menu-item-danger {
  color: var(--ae-ctxmenu-danger) !important;
}
.ctx-menu-item-danger:hover {
  background: var(--ae-ctxmenu-danger-hover) !important;
}
.ctx-shortcut {
  color: v-bind(cardMetaColor);
  font-size: 11px;
  margin-left: 16px;
}
.ctx-separator {
  height: 1px;
  background: v-bind(tbBorder);
  margin: 3px 0;
}
.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

/* ── 素材选中悬浮工具条（ima 风格：毛玻璃胶囊 + 线性图标） ── */
.mat-float-toolbar {
  position: fixed;
  z-index: 10001;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.10);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  color: #1f2937;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}
.mat-float-toolbar.is-dark {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(38, 38, 50, 0.94);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.50), 0 2px 8px rgba(0, 0, 0, 0.35);
  color: #c0caf5;
}
.mat-tb-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  transition: background 0.12s ease;
}
.mat-tb-btn svg { flex-shrink: 0; }
.mat-tb-btn:hover { background: rgba(0, 0, 0, 0.06); }
.mat-float-toolbar.is-dark .mat-tb-btn:hover { background: rgba(255, 255, 255, 0.10); }

/* ── 笔记下拉面板（素材工具栏，不透明） ── */
.mat-note-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  min-width: 200px;
  max-width: 280px;
  max-height: 320px;
  overflow-y: auto;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #ffffff;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
  color: #1f2937;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  z-index: 10002;
}
.mat-note-dropdown.is-dark {
  border-color: rgba(255, 255, 255, 0.14);
  background: #2a2a3c;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.50), 0 2px 8px rgba(0, 0, 0, 0.35);
  color: #c0caf5;
}
.mat-note-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.1s ease;
}
.mat-note-item:hover {
  background: rgba(0, 0, 0, 0.06);
}
.mat-note-dropdown.is-dark .mat-note-item:hover {
  background: rgba(255, 255, 255, 0.10);
}
.mat-note-divider {
  height: 1px;
  margin: 3px 7px;
  background: rgba(0, 0, 0, 0.08);
}
.mat-note-dropdown.is-dark .mat-note-divider {
  background: rgba(255, 255, 255, 0.10);
}
.mat-note-section-header {
  padding: 5px 10px 3px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.5;
}
.mat-note-empty {
  padding: 10px 12px;
  font-size: 12px;
  opacity: 0.45;
  text-align: center;
}

/* ── 表格格选面板 ── */
.rich-table-picker {
  border: 1px solid;
  border-radius: 6px;
  box-shadow: var(--ae-dropdown-shadow);
}
.rich-table-grid {
  display: grid;
  grid-template-columns: repeat(10, 18px);
  grid-template-rows: repeat(10, 18px);
  gap: 2px;
}
.rich-table-cell {
  width: 18px;
  height: 18px;
  border: 1px solid v-bind(tbBorder);
  border-radius: 2px;
  cursor: pointer;
  transition: background 0.1s;
}
.rich-table-cell-active {
  background: var(--ae-table-cell-active-bg);
  border-color: var(--ae-table-cell-active-border);
}
.rich-table-cell-header {
  background: var(--ae-table-cell-header-bg);
}

/* ── 表格列控手柄 ── */
.rich-content .ProseMirror .column-resize-handle {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--ae-column-resize);
  cursor: col-resize;
  z-index: 1;
  pointer-events: auto;
}

/* ── 查找替换面板 ── */
.rich-search-panel {
  gap: 4px;
}
.rich-search-input {
  border: 1px solid;
}
.rich-search-input:focus {
  border-color: var(--ae-search-focus-border) !important;
}
.rich-search-btn {
  height: 24px;
  padding: 0 6px;
  border-radius: 3px;
  border: 1px solid v-bind(tbBorder);
  cursor: pointer;
  background: transparent;
  color: v-bind(btnText);
  transition: background 0.15s;
  display: inline-flex;
  align-items: center;
}
.rich-search-btn:hover:not(:disabled) {
  background: v-bind(btnHoverBg);
}
.rich-search-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* ── 大纲导航面板 ── */
.rich-outline {
  animation: outlineSlideIn 0.15s ease-out;
}
@keyframes outlineSlideIn {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}
.rich-outline .outline-item:hover {
  background: v-bind(ddHoverBg);
}
.rich-outline .outline-lv1 {
  font-weight: 600;
}
</style>
