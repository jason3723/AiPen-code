/**
 * 使用 @tiptap/markdown (MarkdownManager) 将 Markdown 文本转换为 ProseMirror JSON。
 * 与编辑器 schema 完全一致，支持标题、加粗、斜体、代码块、表格、链接等完整 Markdown 语法。
 */
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import ImageExt from '@tiptap/extension-image'

const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4] },
    link: { openOnClick: false },
  }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  ImageExt,
]

const md = new MarkdownManager({ extensions })

export function markdownToDocJson(markdown: string): any {
  if (!markdown) return { type: 'doc', content: [] }
  return md.parse(markdown)
}
