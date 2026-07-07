# 全域搜索 + 候选库 技术方案

> 版本：v1.1（中文精准搜索）
> 最后更新：2026-07-07
> 状态：待开发

---

## 一、功能概览

| # | 功能 | 简述 |
|---|------|------|
| F1 | 右键新增「添加到候选库」 | 三段右键菜单（浏览器注入脚本、编辑器、侧栏）各加一项 |
| F2 | 左侧搜索面板 | 搜文档标题+正文、素材标题+正文，命中词高亮，内容命中展示首段上下文 |
| F3 | 搜索结果→打开+高亮+跳转 | 点击结果加载文档/素材，ProseMirror 内高亮关键词，自动跳转到首个命中位置 |
| F4 | 浮动候选库面板 | 编辑区左侧边缘半透明三杠图标，展开后显示所有候选条目 |
| F5 | 候选条目操作 | 每条的「跳转出处」「删除」两个图标按钮，底部「清空所有」按钮 |
| F6 | AI 对话集成 | 候选面板内全选开关（默认全选），结合候选内容发起 AI 对话 |
| F7 | AI 消息右键 | AI 生成的回复支持「复制」「导入到素材库」 |
| F8 | 搜索历史 | localStorage 存储，可删除 |

---

## 二、架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                         EditorView.vue                            │
│  ┌──────────┐  ┌──────────────────────┐  ┌───────────────────┐  │
│  │ 左侧面板  │  │     编辑区 main       │  │     右侧面板       │  │
│  │          │  │                      │  │                   │  │
│  │ 文档     │  │  ┌─ ☰ 候选库 ──────┐  │  │  AI对话 / 版本    │  │
│  │ 素材     │  │  │ (浮动面板组件)   │  │  │  / 技能 / ...    │  │
│  │ 浏览器   │  │  └────────────────┘  │  │                   │  │
│  │ ★搜索   │  │                      │  │                   │  │
│  │          │  │   RichEditor.vue     │  │                   │  │
│  │ 搜索面板  │  │   (ProseMirror)     │  │                   │  │
│  │ - 输入框  │  │   + 高亮 + 跳转     │  │                   │  │
│  │ - 历史    │  │                      │  │                   │  │
│  │ - 结果列表│  │                      │  │                   │  │
│  └──────────┘  └──────────────────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

数据流：
  搜索输入 → invoke("search_documents", query) → Rust SQLite FTS → 返回命中列表
           → invoke("search_materials", query)  → Rust SQLite FTS → 返回命中列表
           → 前端合并渲染

  添加到候选库 → candidateStore.add(item)
  候选库对话   → 拼接候选内容 → ChatPanel.injectedText → send_chat_message
```

---

## 三、后端改动（Rust）

### 3.1 jieba-rs 中文分词 + SQLite FTS5

**文件**：`src-tauri/src/db.rs`

#### 3.1.1 新增依赖

**文件**：`src-tauri/Cargo.toml`

```toml
[dependencies]
jieba-rs = "0.7"
```

#### 3.1.2 分词辅助模块

**文件**：`src-tauri/src/tokenizer.rs`（新建）

```rust
use jieba_rs::Jieba;
use std::sync::OnceLock;

/// 全局单例 Jieba 实例（线程安全，懒加载）
fn jieba() -> &'static Jieba {
    static INSTANCE: OnceLock<Jieba> = OnceLock::new();
    INSTANCE.get_or_init(|| Jieba::new())
}

/// 将文本分词后用空格连接，供 FTS5 索引
/// "用户登录功能" → "用户 登录 功能"
pub fn segment(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    jieba().cut(text, true).join(" ")
}

/// 将 ProseMirror JSON 内容提取为纯文本并分词
/// 用于 FTS 索引写入和搜索
pub fn segment_prosemirror_json(json_str: &str) -> String {
    let plain = extract_plain_text(json_str);
    segment(&plain)
}

/// ProseMirror JSON → 纯文本
fn extract_plain_text(json: &str) -> String {
    let doc: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => {
            // 不是 JSON，可能已经是纯文本（旧数据）
            return json.to_string();
        }
    };
    let mut texts: Vec<String> = Vec::new();
    fn walk(node: &serde_json::Value, texts: &mut Vec<String>) {
        if let Some(t) = node.get("text").and_then(|v| v.as_str()) {
            texts.push(t.to_string());
        }
        if let Some(children) = node.get("content").and_then(|v| v.as_array()) {
            for child in children {
                walk(child, texts);
            }
        }
    }
    walk(&doc, &mut texts);
    texts.join(" ")
}
```

**`segment()` 行为说明**：
- 输入 `"用户登录功能需要支持手机号验证码"`
- 输出 `"用户 登录 功能 需要 支持 手机号 验证码"`
- FTS5 以空格为分隔符，每个词作为一个独立 token
- 搜索 `"登录"` → jieba 分词为 `"登录"` → FTS5 精确匹配 token `"登录"`
- 搜索 `"登"` → jieba 分词为 `"登"` → 也能命中（单字分词）

#### 3.1.3 FTS5 虚拟表

在 `init_db()` 末尾（`Ok(pool)` 之前）新增：

```sql
-- 文档 FTS：content 列存储 jieba 分词后的文本
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
    doc_id UNINDEXED,
    title,
    content,         -- ← jieba 分词后的纯文本（空格分隔）
    tokenize='unicode61'
);

-- 素材 FTS
CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(
    material_id UNINDEXED,
    title,
    content,         -- ← jieba 分词后的纯文本（空格分隔）
    source_title,
    source_url UNINDEXED,
    tokenize='unicode61'
);
```

**为什么 `tokenize='unicode61'` 仍然是安全的？**

因为存入的 `content` 列已经是 jieba 分词后的 `"用户 登录 功能"`，`unicode61` tokenizer 遇到英文空格天然分 token：
- token 1: `用户`
- token 2: `登录`
- token 3: `功能`

搜索时同样将 query 用 jieba 分词 → `"登录"` → FTS5 只匹配完整词 `"登录"`，不会拆成 `"登"` 和 `"录"`。

#### 3.1.4 索引同步

每次写入文档/素材时需要先 jieba 分词再插入 FTS。改动以下 Rust 函数：

| Rust 函数 | 触发时机 | FTS 操作 |
|-----------|---------|---------|
| `save_draft()` | 编辑器自动保存草稿 | `INSERT OR REPLACE INTO doc_fts(doc_id, title, content) VALUES(?, ?, segment_prosemirror_json(?))` |
| `create_document()` | 新建文档 | `INSERT INTO doc_fts(...)` |
| `update_document_title()` | 重命名文档 | `UPDATE doc_fts SET title = ? WHERE doc_id = ?` |
| `delete_document()` | 删除文档 | `DELETE FROM doc_fts WHERE doc_id = ?` |
| `save_material()` | 新建素材 | `INSERT INTO material_fts(...)` |
| `update_material_content()` | 更新素材 | `UPDATE material_fts SET content = segment_prosemirror_json(?) WHERE material_id = ?` |
| `delete_material()` | 删除素材 | `DELETE FROM material_fts WHERE material_id = ?` |

**首次初始化时的全量重建**：在 `init_db()` 中检测 `doc_fts` 表是否为空，若为空则执行：

```rust
// 全量重建文档 FTS 索引
let docs = sqlx::query_as::<_, (String, String, String)>(
    "SELECT id, title, draft_content FROM documents"
).fetch_all(&pool).await?;

for (id, title, content) in &docs {
    let segmented = segment_prosemirror_json(content);
    sqlx::query(
        "INSERT INTO doc_fts(doc_id, title, content) VALUES(?1, ?2, ?3)"
    )
    .bind(id).bind(title).bind(&segmented)
    .execute(&pool).await?;
}

// 同理处理 materials
```

#### 3.1.5 索引重建注意事项

- **标题**不需要分词：`title` 列以 `UNINDEXED` 形式直接存原始标题，搜索时用 `MATCH` 匹配 `title` 列
- 实际上 FTS5 的 `MATCH` 默认搜所有索引列。如果只想按 `content` 列搜，SQL 写 `WHERE doc_fts MATCH 'content:登录'`。但通常标题也包含命中词，混合搜索可以接受
- `doc_id`、`source_url`、`material_id` 标记为 `UNINDEXED`，不参与搜索结果排序，仅用于回表 JOIN

### 3.2 新增 Tauri 命令

**文件**：`src-tauri/src/commands.rs`

#### 3.2.1 `search_documents`

```rust
use crate::tokenizer::segment;

#[tauri::command]
pub async fn search_documents(
    query: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let segmented = segment(&query);  // "用户登录" → "用户 登录"

    let pool = &state.pool;
    let results = sqlx::query_as::<_, SearchResultRow>(
        "SELECT
            d.id AS doc_id,
            d.title,
            snippet(doc_fts, 1, '<mark>', '</mark>', '...', 40) AS snippet,
            d.project_id,
            d.updated_at
         FROM doc_fts
         JOIN documents d ON d.id = doc_fts.doc_id
         WHERE doc_fts MATCH ?1
         ORDER BY rank
         LIMIT 50"
    )
    .bind(&segmented)   // ★ 用分词后的 query 做 FTS 搜索
    .fetch_all(pool)
    .await
    .map_err(|e| format!("搜索失败: {}", e))?;

    Ok(results.into_iter().map(|r| SearchResult {
        id: r.doc_id,
        title: r.title,
        snippet: r.snippet,
        source_type: "document".to_string(),
        folder_id: r.project_id,
        updated_at: r.updated_at,
    }).collect())
}
```

**搜索流程**：
```
用户输入: "登录功能"
    ↓ segment("登录功能")
分词结果: "登录 功能"
    ↓ MATCH '登录 功能'
FTS5: 匹配所有同时包含 token "登录" 和 token "功能" 的文档
    ↓ snippet() 自动高亮
返回: 带 <mark> 标签的高亮片段
```

**`snippet()` 函数说明**：SQLite FTS5 内置函数，自动提取命中关键词附近的文本片段，并用指定标记包裹命中词。参数：
- `1`：使用 FTS 表第 1 列（title+content 等索引列）
- `'<mark>'` / `'</mark>'`：前端直接用 `v-html` 渲染
- `'...'`：片段之间的省略号
- `40`：每个片段最多 40 个 token

**模糊搜索支持**：用户可以加 FTS5 前缀搜索语法，如 `"登*"` 匹配以"登"开头的所有词（登录、登入、登记...）。前端可不暴露此语法给用户，作为未来扩展。

#### 3.2.2 `search_materials`

```rust
#[tauri::command]
pub async fn search_materials(
    query: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    // 结构与 search_documents 相同，查 material_fts JOIN materials
    // snippet 返回 content 列的命中片段
}
```

#### 3.2.3 数据结构

```rust
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
struct SearchResultRow {
    doc_id: Option<String>,      // 文档时使用
    material_id: Option<String>, // 素材时使用
    title: String,
    snippet: String,
    project_id: Option<String>,
    source_title: Option<String>,
    source_url: Option<String>,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,             // 文档ID 或 素材ID
    pub title: String,
    pub snippet: String,        // 含 <mark> 标签的 HTML 片段
    pub source_type: String,    // "document" | "material"
    pub folder_id: Option<String>,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub updated_at: String,
}
```

#### 3.2.4 注册命令

**文件**：`src-tauri/src/lib.rs`

在 `.invoke_handler(tauri::generate_handler![...])` 中添加：
```rust
search_documents,
search_materials,
```

### 3.3 浏览器注入脚本改动

**文件**：`src-tauri/src/commands.rs` → `BROWSER_INIT_SCRIPT`

在右键菜单数组中新增一项：

```javascript
{
    label: '📋 添加到候选库',
    action: function(text, url, title) {
        sendToAiPen('candidate', text, url, title);
    }
}
```

**数据传输**：复用现有双重通道机制：
- IPC 通道：emit 新事件 `browser-add-to-candidate`
- URL 通道：导航到 `https://aipen-clip.internal/candidate/<base64>`

**Rust 端**：`on_navigation` 中新增 `/candidate/` 路径拦截，与 `/save/`、`/chat/` 逻辑平行。

**EditorView 端**：新增监听 `browser-add-to-candidate` 事件，调用 `candidateStore.add(...)`。

---

## 四、前端改动

### 4.1 新增 Store：`candidateStore.ts`

**文件**：`src/stores/candidateStore.ts`（新建）

```typescript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface CandidateItem {
  id: string;              // 唯一ID
  text: string;            // 选中文本（纯文本）
  sourceType: 'document' | 'material' | 'browser';
  sourceId: string;        // 文档/素材ID（browser 时为空）
  sourceTitle: string;     // 文档标题 / 素材标题 / 网页标题
  sourceUrl?: string;      // 浏览器来源URL
  selected: boolean;       // AI 对话时是否引用
  createdAt: number;       // Date.now()
}

export const useCandidateStore = defineStore('candidate', () => {
  const items = ref<CandidateItem[]>([]);
  const panelVisible = ref(false);

  function add(item: Omit<CandidateItem, 'id' | 'selected' | 'createdAt'>) {
    const id = crypto.randomUUID();
    items.value.push({
      ...item,
      id,
      selected: true,     // 默认选中
      createdAt: Date.now(),
    });
  }

  function remove(id: string) {
    items.value = items.value.filter(i => i.id !== id);
  }

  function clearAll() {
    items.value = [];
  }

  function toggleItem(id: string) {
    const item = items.value.find(i => i.id === id);
    if (item) item.selected = !item.selected;
  }

  function toggleAll() {
    const allSelected = items.value.every(i => i.selected);
    items.value.forEach(i => { i.selected = !allSelected; });
  }

  const allSelected = computed(() =>
    items.value.length > 0 && items.value.every(i => i.selected)
  );

  const contextText = computed(() =>
    items.value
      .filter(i => i.selected)
      .map(i => `> 来源：${i.sourceTitle}\n\n${i.text}`)
      .join('\n\n---\n\n')
  );

  return { items, panelVisible, add, remove, clearAll, toggleItem,
           toggleAll, allSelected, contextText };
});
```

### 4.2 搜索面板（左侧 Tab）

#### 4.2.1 `leftSubTab` 扩展

**文件**：`src/views/EditorView.vue`

```typescript
const leftSubTab = ref<'docs' | 'materials' | 'browser' | 'search'>('docs');
```

Tab 按钮数组新增：
```html
{ key: 'search' as const, label: '搜索' }
```

#### 4.2.2 搜索面板组件 `SearchPanel.vue`

**文件**：`src/components/SearchPanel.vue`（新建）

**Props & Emits**：
```typescript
defineProps<{
  docStore: ReturnType<typeof useDocumentStore>;
  materialStore: ReturnType<typeof useMaterialStore>;
}>();

const emit = defineEmits<{
  navigateToDocument: [docId: string, query: string];
  navigateToMaterial: [matId: string, query: string];
}>();
```

**状态**：
```typescript
const query = ref('');
const loading = ref(false);
const results = ref<UnifiedSearchResult[]>([]);
const history = ref<string[]>([]); // localStorage
```

**搜索逻辑**（防抖 300ms）：

```typescript
async function doSearch() {
  if (!query.value.trim()) { results.value = []; return; }
  loading.value = true;
  try {
    const [docResults, matResults] = await Promise.all([
      invoke<SearchResult[]>('search_documents', { query: query.value }),
      invoke<SearchResult[]>('search_materials', { query: query.value }),
    ]);
    results.value = [
      ...docResults.map(r => ({ ...r, sourceType: 'document' as const })),
      ...matResults.map(r => ({ ...r, sourceType: 'material' as const })),
    ];
    addHistory(query.value);
  } catch (e) {
    console.error('搜索失败:', e);
  } finally {
    loading.value = false;
  }
}
```

**点击结果**：

```typescript
function clickResult(result: UnifiedSearchResult) {
  if (result.sourceType === 'document') {
    emit('navigateToDocument', result.id, query.value);
  } else {
    emit('navigateToMaterial', result.id, query.value);
  }
}
```

**模板结构**：

```html
<div class="flex flex-col h-full">
  <!-- 搜索输入框 -->
  <div class="p-2">
    <input v-model="query" @input="debouncedSearch"
           placeholder="搜索文档、素材..."
           class="w-full px-3 py-1.5 text-sm rounded border ..." />
  </div>

  <!-- 搜索历史 -->
  <div v-if="!query && history.length" class="px-2">
    <div class="flex justify-between items-center mb-1">
      <span class="text-[10px] text-gray-400">最近搜索</span>
      <button @click="clearHistory" class="text-[10px] text-gray-400 hover:text-red-400">
        清空
      </button>
    </div>
    <div v-for="h in history" :key="h"
         @click="query = h; doSearch()"
         class="text-xs px-2 py-1 cursor-pointer hover:bg-gray-100 rounded ...">
      {{ h }}
    </div>
  </div>

  <!-- 搜索结果列表 -->
  <div class="flex-1 overflow-y-auto px-2">
    <div v-for="r in results" :key="r.id"
         @click="clickResult(r)"
         class="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded p-2 mb-1">
      <div class="flex items-center gap-1">
        <span class="text-[10px] px-1 rounded"
              :class="r.sourceType === 'document' ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-600'">
          {{ r.sourceType === 'document' ? '文档' : '素材' }}
        </span>
        <span class="text-xs font-medium truncate">{{ r.title }}</span>
      </div>
      <!-- snippet 含 <mark> 标签，v-html 渲染高亮 -->
      <div v-if="r.snippet" class="text-[11px] text-gray-500 mt-1 line-clamp-2"
           v-html="r.snippet" />
      <div class="text-[10px] text-gray-400 mt-0.5">
        {{ formatDate(r.updated_at) }}
      </div>
    </div>
    <!-- 空结果 -->
    <div v-if="query && !loading && results.length === 0"
         class="text-center text-xs text-gray-400 mt-8">
      无匹配结果
    </div>
  </div>
</div>
```

### 4.3 ProseMirror 高亮 + 跳转（搜索结果点击后）

**文件**：`src/components/RichEditor.vue`

#### 4.3.1 新增 Props

```typescript
const props = defineProps<{
  // ... 现有 props ...
  highlightQuery?: string;  // ★ 新增：外部传入的搜索词，用于打开文档后高亮
}>();
```

#### 4.3.2 watch + 自动高亮

```typescript
// 监听 highlightQuery：搜索面板点击结果 → 打开文档 → 内容加载 → 自动高亮
watch(
  () => props.highlightQuery,
  async (q) => {
    if (!q || !editor.value) return;
    // 等待编辑器就绪（内容可能还未渲染完毕）
    await nextTick();
    const ed = editor.value;
    if (!ed) return;
    setTimeout(() => {
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
    }, 150); // 延迟确保 ProseMirror 视图已更新
  },
  { immediate: false }
);
```

**注意**：上述逻辑与现有 `doSearch()` 函数高度重叠，建议抽取一个通用函数：

```typescript
function highlightInEditor(query: string, autoJump: boolean = true) {
  const ed = editor.value;
  if (!ed || !query) return;
  _searchMatches = [];
  const q = query.toLowerCase();
  ed.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    // ... 匹配逻辑同上 ...
  });
  applySearchDecorations();
  searchCount.value = _searchMatches.length;
  searchIdx.value = _searchMatches.length > 0 ? 1 : 0;
  if (autoJump && _searchMatches.length > 0) {
    goToResult(0);
  }
}
```

#### 4.3.3 区分内部搜索与外部高亮

给 `search-highlight` class 增加一个数据属性 `data-search-source="external"` 用于区分：
- 内部 Ctrl+F 搜索：用户可以关闭搜索结果面板，高亮跟随面板关闭
- 外部搜索结果跳转：高亮持久显示，直到用户切换到其他文档或清除

实现方式：增加一个 `isExternalHighlight` 标志，在高亮装饰的 `class` 中附加 `search-highlight-external`，用不同颜色区分（如黄色=内部搜索、橙色=外部跳转）。

### 4.4 浮动候选库面板

**文件**：`src/components/CandidatePanel.vue`（新建）

#### 4.4.1 结构

```
EditorView 模板中：
<main ref="mainAreaRef" class="relative flex-1 ...">
  <CandidatePanel />  <!-- ★ 新增，使用 position: absolute -->
  ... 原有编辑器内容 ...
</main>
```

#### 4.4.2 组件设计

```html
<template>
  <div class="candidate-panel-wrapper">
    <!-- 半透明三杠触发图标 -->
    <button
      v-if="!candidateStore.panelVisible"
      class="candidate-trigger"
      @click="candidateStore.panelVisible = true"
      title="候选库"
    >
      <svg><!-- 三横线图标 --></svg>
    </button>

    <!-- 展开面板 -->
    <div v-if="candidateStore.panelVisible" class="candidate-panel">
      <!-- 头部：标题 + AI 对话开关 + 关闭按钮 -->
      <div class="candidate-panel-header">
        <span>候选库 ({{ candidateStore.items.length }})</span>
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1 text-[11px]">
            <input type="checkbox"
                   :checked="candidateStore.allSelected"
                   @change="candidateStore.toggleAll()" />
            全选
          </label>
          <button @click="openCandidateChat"
                  class="text-[11px] px-2 py-0.5 bg-blue-500 text-white rounded">
            💬 对话
          </button>
          <button @click="candidateStore.panelVisible = false">✕</button>
        </div>
      </div>

      <!-- 条目列表 -->
      <div class="candidate-panel-body">
        <div v-for="item in candidateStore.items" :key="item.id"
             class="candidate-item">
          <label class="flex items-start gap-2">
            <input type="checkbox" v-model="item.selected" />
            <div class="flex-1 min-w-0">
              <p class="text-xs line-clamp-2">{{ item.text }}</p>
              <p class="text-[10px] text-gray-400 mt-0.5">
                来源：{{ item.sourceTitle }}
                {{ item.sourceUrl ? ' · ' + item.sourceUrl : '' }}
              </p>
            </div>
          </label>
          <div class="flex gap-1 ml-5 mt-1">
            <button @click="jumpToSource(item)" title="跳转到出处">
              <svg><!-- 跳转图标 --></svg>
            </button>
            <button @click="candidateStore.remove(item.id)" title="删除">
              <svg><!-- 删除图标 --></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 底部：清空所有 -->
      <div class="candidate-panel-footer">
        <button @click="candidateStore.clearAll()"
                class="text-[11px] text-red-400 hover:text-red-500">
          🗑 清空所有候选
        </button>
      </div>
    </div>
  </div>
</template>
```

#### 4.4.3 样式要点

```css
.candidate-panel-wrapper {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 100;
  pointer-events: none; /* 启用后可穿透到编辑器 */
}

.candidate-trigger {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%) translateX(-75%);
  opacity: 0.3;
  transition: all 0.2s;
  pointer-events: auto;
  /* 半露出状态，hover 时完全显示 */
}
.candidate-trigger:hover {
  opacity: 0.9;
  transform: translateY(-50%) translateX(0);
}

.candidate-panel {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  background: var(--ae-panel-bg);
  border-right: 1px solid var(--ae-panel-border);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  animation: slideIn 0.2s ease;
}

@keyframes slideIn {
  from { transform: translateX(-100%); }
  to   { transform: translateX(0); }
}
```

#### 4.4.4 跳转逻辑

```typescript
function jumpToSource(item: CandidateItem) {
  candidateStore.panelVisible = false;
  if (item.sourceType === 'document') {
    emit('navigateToDocument', item.sourceId, '');
  } else if (item.sourceType === 'material') {
    emit('navigateToMaterial', item.sourceId, '');
  }
  // browser 类型：打开浏览器并导航
  else if (item.sourceType === 'browser' && item.sourceUrl) {
    emit('openBrowser', item.sourceUrl);
  }
}
```

### 4.5 三段右键菜单改动

#### 4.5.1 浏览器注入脚本

见 §3.3，已在 Rust 改动中涵盖。

#### 4.5.2 RichEditor 右键菜单

**文件**：`src/components/RichEditor.vue` 模板（第 1815-1819 行附近）

在「添加到 AI 对话」下方新增：

```html
<div class="ctx-menu-item" @click.stop="execCtxMenuAddToCandidate">
  <span>📋 添加到候选库</span><span class="ctx-shortcut" />
</div>
```

```typescript
function execCtxMenuAddToCandidate() {
  if (!ctxMenuSelText.value) return;
  candidateStore.add({
    text: ctxMenuSelText.value,
    sourceType: props.editMode === 'material' ? 'material' : 'document',
    sourceId: props.editMode === 'material'
      ? materialStore.currentMaterialId || ''
      : docStore.currentDocId || '',
    sourceTitle: props.editMode === 'material'
      ? (materialStore.materials.find(m => m.id === materialStore.currentMaterialId)?.title || '未命名素材')
      : (docStore.currentTitle || '未命名文档'),
  });
  closeCtxMenu();
}
```

#### 4.5.3 EditorView 侧栏右键菜单

**文件**：`src/views/EditorView.vue` 侧栏右键菜单模板

在「添加到 AI 对话」下方新增同样格式的菜单项。

### 4.6 AI 消息右键菜单（F7）

**文件**：`src/components/ChatPanel.vue`

#### 4.6.1 模板改动

在 AI 消息 bubble 上添加 `@contextmenu.prevent`：

```html
<div v-for="msg in messages" :key="msg.id" class="...">
  <template v-if="msg.role === 'user'">
    <!-- 用户消息：不变 -->
  </template>
  <div v-else
       class="ai-message-bubble ..."
       @contextmenu.prevent="onAiMsgContextMenu($event, msg)">
    <div v-html="renderMarkdown(msg.content)" />
  </div>
</div>

<!-- AI 消息右键菜单 (Teleport to body) -->
<Teleport to="body">
  <div v-if="aiCtxMenu.show" class="ctx-menu" :style="{ left: aiCtxMenu.x + 'px', top: aiCtxMenu.y + 'px' }">
    <div class="ctx-menu-item" @click="copyAiMsg()">
      <span>复制</span><span class="ctx-shortcut">Ctrl+C</span>
    </div>
    <div class="ctx-menu-item" @click="clipAiMsg()">
      <span>📦 导入到素材库</span><span class="ctx-shortcut" />
    </div>
  </div>
</Teleport>

<!-- 遮罩层：点击关闭菜单 -->
<div v-if="aiCtxMenu.show" class="fixed inset-0 z-[9999]"
     @click="aiCtxMenu.show = false" @contextmenu.prevent="aiCtxMenu.show = false" />
```

#### 4.6.2 逻辑

```typescript
const aiCtxMenu = ref<{ show: boolean; x: number; y: number; msg: ChatMessage | null }>({
  show: false, x: 0, y: 0, msg: null,
});

function onAiMsgContextMenu(event: MouseEvent, msg: ChatMessage) {
  event.preventDefault();
  aiCtxMenu.value = { show: true, x: event.clientX, y: event.clientY, msg };
}

async function copyAiMsg() {
  const text = aiCtxMenu.value.msg?.content || '';
  try { await navigator.clipboard.writeText(text); } catch {}
  aiCtxMenu.value.show = false;
}

function clipAiMsg() {
  const text = aiCtxMenu.value.msg?.content || '';
  if (text) {
    const matStore = useMaterialStore();
    matStore.openClipDialog(text, undefined, 'AI 对话');
  }
  aiCtxMenu.value.show = false;
}
```

### 4.7 候选库与 AI 对话集成（F6）

```typescript
// CandidatePanel.vue 中
const docStore = useDocumentStore();

function openCandidateChat() {
  // 1. 将候选内容注入 ChatPanel
  docStore.injectedChatText = candidateStore.contextText;
  // 2. 切换到 AI 对话 Tab
  docStore.sidebarTab = 'chat';
  // 3. 关闭候选面板
  candidateStore.panelVisible = false;
}
```

候选内容格式（通过 `contextText` computed 自动生成）：

```
> 来源：需求文档 v3

用户登录功能需要支持手机号+验证码...

---

> 来源：竞品分析素材

某竞品的登录流程包含以下步骤...

---

> 来源：技术调研笔记

https://example.com/article
短信验证码接入方案调研...
```

### 4.8 搜索历史（F8）

**文件**：`src/components/SearchPanel.vue` 内联或提取为 composable

```typescript
const HISTORY_KEY = 'aipen_search_history';
const MAX_HISTORY = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function addHistory(query: string) {
  const h = loadHistory().filter(q => q !== query);
  h.unshift(query);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)));
  history.value = h.slice(0, MAX_HISTORY);
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  history.value = [];
}

function removeHistoryItem(query: string) {
  const h = loadHistory().filter(q => q !== query);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  history.value = h;
}

// onMounted
history.value = loadHistory();
```

---

## 五、改动文件清单

```
文件                                    新增行    删除行    净变化    说明
──────────────────────────────────────────────────────────────────────
src-tauri/Cargo.toml                     +1        0       +1      jieba-rs 依赖
src-tauri/src/tokenizer.rs               +45       0       +45     新建：jieba 分词 + ProseMirror 文本提取
src-tauri/src/db.rs                      +100      0       +100    FTS 表创建 + 全量初始化 + 写入同步
src-tauri/src/commands.rs                +110      +10     +120    两个搜索命令 + 候选库注入脚本
src-tauri/src/lib.rs                     +2        0       +2      注册新命令 + tokenizer 模块声明
src/stores/candidateStore.ts             +80       0       +80     新建
src/components/SearchPanel.vue           +200      0       +200    新建
src/components/CandidatePanel.vue        +180      0       +180    新建
src/views/EditorView.vue                 +40       5       +35     leftSubTab 扩展 + 搜索Tab渲染
                                                                   + 候选面板挂载 + 侧栏右键菜单
                                                                   + 导航处理函数
src/components/RichEditor.vue            +40       0       +40     highlightQuery prop + watch
                                                                    + 右键菜单新增项
src/components/ChatPanel.vue             +55       0       +55     AI消息右键 + 复制/导入素材
──────────────────────────────────────────────────────────────────────
合计                                     ~853      ~15     ~838
```

---

## 六、实施步骤

### 阶段一：后端基础（预计 1-2 天）

1. **db.rs**：创建 `doc_fts`、`material_fts` 虚拟表 + 全量初始化 + 写入同步
2. **commands.rs**：实现 `search_documents`、`search_materials` + 候选库注入脚本改动
3. **lib.rs**：注册新命令
4. **验证**：`cargo build` 无报错，手动调用搜索命令返回正确结果

### 阶段二：搜索面板（预计 1 天）

1. **SearchPanel.vue**：搜索面板组件（输入框 + 历史 + 结果列表）
2. **EditorView.vue**：`leftSubTab` 扩展 + Tab 按钮 + 渲染 SearchPanel
3. **验证**：输入关键词，结果列表正确渲染，高亮正确

### 阶段三：搜索结果跳转 + 高亮（预计 1 天）

1. **RichEditor.vue**：新增 `highlightQuery` prop + watch 自动高亮 + scrollIntoView
2. **EditorView.vue**：`navigateToDocument` / `navigateToMaterial` 导航处理
3. **验证**：点击搜索结果 → 编辑器打开 → 命中词高亮 → 自动滚动到第一个命中

### 阶段四：候选库核心（预计 1.5 天）

1. **candidateStore.ts**：创建候选库 Pinia store
2. **CandidatePanel.vue**：浮动面板组件（三杠触发 + 展开列表 + AI 对话按钮）
3. **三段右键菜单**：各加"添加到候选库"项
4. **验证**：从文档/素材/浏览器收集候选条目，面板正确展示

### 阶段五：AI 集成 + 搜索历史 + 杂项（预计 1 天）

1. **ChatPanel.vue**：AI 消息右键（复制 + 导入素材）
2. **CandidatePanel.vue**：全选开关 + 对话按钮逻辑
3. **SearchPanel.vue**：搜索历史 localStorage
4. **验证**：完整流程端到端测试

---

## 七、关键决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 搜索范围 | 只搜标题 / 标题+正文 | **标题+正文** | 用户体验完整 |
| 正文搜索方式 | 前端遍历 / 后端 FTS | **后端 FTS + jieba-rs** | 精准分词 + 高性能 + snippet 自动生成 |
| 中文分词方案 | unicode61 单字 / jieba-rs | **jieba-rs** | 词级索引，"登录"是一个 token，不是"登"+"录" |
| FTS 索引内容 | draft_content / versions.content | **draft_content** | 用户搜的是最新内容，不需要搜历史版本 |
| 候选库持久化 | 内存 / localStorage / SQLite | **内存**（不持久化） | 候选库是临时工作台，关闭程序清空符合直觉 |
| 搜索高亮与内部高亮 | 共享插件 / 独立插件 | **共享 `searchPluginKey`** | 复用现有插件，用 data 属性区分来源 |
| 候选面板位置 | Teleport body / main 内 absolute | **main 内 absolute** | 与编辑区对齐，不跨窗口 |

---

## 八、风险与注意事项

### 🟨 P2-1：jieba-rs 分词精度

jieba-rs 基于词典+隐马尔可夫模型，对常见中文词汇分词准确率高（>95%），但以下场景需注意：

| 场景 | 示例 | jieba 结果 | 影响 |
|------|------|-----------|------|
| 专业术语 | "去中心化金融" | "去中心化 金融" ✅ | 正常 |
| 人名 | "张小明发表了" | "张小明 发表 了" ✅ | 正常 |
| 新词/网络用语 | "大语言模型" | "大 语言 模型"（或"大语言 模型"） | 可能拆开，但不影响关键词召回 |
| 中英混合 | "API接口设计" | "API 接口 设计" ✅ | 正常（jieba 自动识别英文 token） |
| 超短查询 | "的" | "的" | 停用词需要前端过滤 |

**缓解**：
- 搜索时同时用原始 query 做 LIKE 兜底：`WHERE (doc_fts MATCH ?1) OR (d.title LIKE '%?2%')`
- 前端过滤 1-2 字符的超短查询（提示"请输入至少 2 个字符"）
- ProseMirror 端高亮用原始 query（不做分词），因为高亮是纯文本 `indexOf`，不受分词影响

### 🟨 P2-2：FTS 索引同步一致性

每次 `save_draft` 都要同步更新 FTS 索引。如果中间某次写入失败，FTS 索引可能与 `draft_content` 不一致。

**缓解**：
- 同步写入放在 `save_draft` 的 try-catch 内，失败只 eprintln，不阻断正常保存流程
- 提供一个「重建索引」管理功能（如在设置面板），手动触发全量重建

### 🟨 P2-3：ProseMirror 高亮时序

搜索结果点击后需要：
1. 切换 `leftSubTab` → 可能触发 `save_draft`
2. `switchDocument()` / `selectMaterial()` → 异步加载内容
3. `displayedContent` 更新 → RichEditor 重新渲染
4. 此时才能 apply decorations

**缓解**：在 `highlightQuery` watch 中用 `nextTick()` + `setTimeout(150)` 双重延迟，确保编辑器完全就绪。如果仍然不够，监听 `editor.value` 的就绪状态标记。

### 🟨 P2-4：浏览器候选库数据通道

浏览器注入脚本新增的「添加到候选库」需要走 `on_navigation` 拦截 `/candidate/` 路径。由于现有 `/save/` 和 `/chat/` 已经占用两条路径，新增第三条是完全平行的改动，风险低。

### 🟩 P3-1：AI 消息右键菜单

当前 AI 消息通过 `renderMarkdown()` 转为 HTML 后用 `v-html` 渲染。右键时需要获取原始 Markdown 文本（而非 HTML），这在当前 `ChatMessage.content` 中直接可用。
