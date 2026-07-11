import fs from 'fs'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import ImageExt from '@tiptap/extension-image'

const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: false } }),
  Table.configure({ resizable: true }),
  TableRow, TableCell, TableHeader, ImageExt,
]
const md = new MarkdownManager({ extensions })
const text = fs.readFileSync('src-tauri/resources/tutorial.md', 'utf8')
console.log('tutorial.md 长度:', text.length)
const result = md.parse(text)
console.log('parse 结果 type:', result?.type)
console.log('parse 结果 content 是否存在:', Array.isArray(result?.content))
console.log('parse 结果 content.length:', result?.content?.length)
if (result?.content) {
  console.log('前 3 个节点 type:', result.content.slice(0, 3).map(n => n?.type))
}
