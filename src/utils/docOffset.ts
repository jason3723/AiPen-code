/**
 * 文档偏移量 ↔ ProseMirror 文档位置 映射工具
 *
 * 背景：后端 proofread 命令返回的 start/end 是【纯文本】的字符下标
 *      （换行符算一个字符）。但红色波浪线要画在 ProseMirror 文档坐标（绝对 pos）上。
 *
 * 本模块提供"序列化 + 映射"同一套分隔规则（块级之间用单个 '\n'），
 * 保证：发给 LLM 的 text 与 前端用于定位的 map 完全一致。
 *
 * 关键约定：
 *  - text 中每个字符（含 '\n' 分隔符）在 map 中都有一个下标对应的"绝对文档位置"。
   *  - 普通字符：map[i] = 该字符在文档中的起始绝对 pos。
   *  - '\n' 分隔符：map[i] = 块节点的起始绝对 pos（即块节点自身 position，
   *    也是上一段内容结束、本块开始的位置，等于回调传入的 pos，不再 +1）。
 *  - 偏移空间一律用"字符数"计数（[...str] 展开），与 Rust 端 text.chars().count() 一致。
 *
 * doc 参数类型为 ProseMirror Node（项目中以 any 形式使用，符合现有代码风格）。
 */

export interface OffsetMap {
  /** 与发送给 LLM 的纯文本完全一致 */
  text: string
  /** 与 text 逐一对应：map[i] = 第 i 个字符的绝对文档 pos */
  map: number[]
}

function isBlockNode(node: any): boolean {
  return !!node && node.isBlock === true
}

/** 单次遍历：把 [from,to) 区间内的文本拼成 text，并产出 char→pos 的 map */
function walkRange(doc: any, from: number, to: number): OffsetMap {
  let text = ''
  const map: number[] = []
  // 起始视为已分隔，避免开头出现多余 \n
  let lastWasSeparator = true

  doc.nodesBetween(from, to, (node: any, pos: number) => {
    if (node.isText && typeof node.text === 'string' && node.text.length > 0) {
      // nodesBetween 回调的 pos 已是该文本节点起始字符的绝对位置，不要再 +1
      const nodeStart = pos
      const sliceStart = Math.max(nodeStart, from)
      const sliceEnd = Math.min(nodeStart + node.text.length, to)
      if (sliceEnd <= sliceStart) return false
      // 字符级切片（中文安全）
      const chars = [...node.text].slice(sliceStart - nodeStart, sliceEnd - nodeStart)
      for (let j = 0; j < chars.length; j++) {
        text += chars[j]
        map.push(sliceStart + j)
      }
      lastWasSeparator = false
      return false
    }
    // 仅在连续文本之间插入一个块级分隔符；分隔符位置 = 块节点的 pos（其内容开始前）
    if (isBlockNode(node) && !lastWasSeparator) {
      text += '\n'
      map.push(pos)
      lastWasSeparator = true
    }
    return true
  })

  return { text, map }
}

/** 整篇文档的映射 */
export function buildPlainTextAndMap(doc: any): OffsetMap {
  const size = doc?.content?.size ?? 0
  return walkRange(doc, 0, size)
}

/** 选区（或任意区间）的映射：偏移以该区间起点为基准（0..len） */
export function buildPlainTextAndMapRange(doc: any, from: number, to: number): OffsetMap {
  return walkRange(doc, from, to)
}

/** 字符偏移 [start, end) → 文档绝对位置区间 { from, to }；越界返回 null */
export function offsetToRange(map: number[], start: number, end: number): { from: number; to: number } | null {
  if (start < 0 || end <= start || start >= map.length) return null
  const from = map[start]
  const lastIdx = Math.min(end - 1, map.length - 1)
  const to = map[lastIdx] + 1
  if (from == null || to == null) return null
  return { from, to: Math.max(to, from + 1) }
}
