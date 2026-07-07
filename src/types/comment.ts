/**
 * 文档批注类型定义
 *
 * 批注采用「doc 内部 JSON 存储」方案：
 *   - doc 节点 JSON 顶层新增 `comments: Comment[]` 字段
 *   - 文字上的 `comment` Mark 仅保留 `commentId`，实际内容在数组里查
 *   - 这样草稿/版本/回滚/切换文档/备份导入导出全部「白送」自动同步
 *
 * 单用户场景：author 固定为「我」；为未来扩展协作保留字段。
 */

/** 单条批注 */
export interface Comment {
  /** 全局唯一 ID，UUID v4 */
  id: string;
  /** 顺序号（从 1 自增，删除不回收，保持 [n] 编号稳定） */
  order: number;
  /** 批注文字，<= 500 字 */
  text: string;
  /** 创建时间，ISO 8601 */
  createdAt: string;
  /** 最近修改时间，ISO 8601 */
  updatedAt: string;
  /** 作者（单用户场景下固定为「我」，保留扩展位） */
  author: string;
  /** 孤儿标记：true 表示原文已被删除，仅在文末列表保留 */
  orphan: boolean;
}

/** ProseMirror Mark 上的批注属性 */
export interface CommentMarkAttrs {
  commentId: string;
}

/** 包含批注的 ProseMirror 文档结构（持久化格式） */
export interface DocWithComments {
  type: "doc";
  content?: any[];
  /** 批注数组（兼容：v1 文档可能缺失此字段） */
  comments?: Comment[];
  /** 文档 schema 版本（未来扩展兼容用，当前固定为 1） */
  docSchemaVersion?: number;
  // 允许其他 ProseMirror 顶层字段
  [key: string]: any;
}
