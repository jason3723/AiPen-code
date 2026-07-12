# AiPen 实时校对（Proofread）功能 实施方案

> 状态：Phase 1~5 全部完成。每完成一个阶段就地补充技术细节 / 坑 / Checklist。

## 一、总体架构

```
工具栏图标(触发) → proofreadStore.runProofread(doc, from?, to?)
        │  (invoke Rust 命令 proofread)
        ▼
ai.rs::proofread_document(text, config) → Vec<ProofreadItem>  (DeepSeek zero-shot)
        │
        ▼
proofreadStore: items[] + correctWords[] + panelOpen/activeTab(在 compareStore)
        │
        ├─→ RichEditor: proofreadPlugin 画红色波浪线(Decoration.inline)
        └─→ CommentListPanel: 新增 'proofread' tab(集成进统一抽屉)
              ├ 列表: 跳转/替换/忽略/添加为正词
              ├ 正词管理器: 增/删/改
              └ 底部: 一键替换 / 清空结果(清空→面板收起 + trigger 消失)
```

**核心约束**
- 手动触发，不做实时；只标不改，需用户确认。
- 云端出网需明示（产品内提示"文本将发送至配置的 AI 服务做校对"）。
- 校对范围：无选区→全文；有选区→只校对选区。
- 正词：全局，不按文档隔离。
- 模型：直接用全局 `AIConfig.model`，不单独设模型。

## 二、关键技术设计

### 1. 偏移量 ↔ 文档位置映射（最大难点）
- `src/utils/docOffset.ts`:
  - `buildPlainTextAndMap(doc)` → 整篇 `{ text, map }`。
  - `buildPlainTextAndMapRange(doc, from, to)` → 选区/区间 `{ text, map }`（偏移以该区间起点为基准）。
  - `offsetToRange(map, start, end)` → `{ from, to }`。
- **序列化与映射用同一套分隔规则**：块级节点之间用**单个** `\n` 分隔（`doc.nodesBetween` 遍历，仅在连续文本之间插入一个分隔符），保证发给 LLM 的 `text` 与前端用于定位的 `map` 完全一致。
- 偏移空间一律用**字符数**计数（`[...str]` 展开），与 Rust 端 `text.chars().count()` 一致（中文不会错位）。
- map 约定：普通字符 `map[i]` = 该字符在文档中的起始绝对 pos；`\n` 分隔符 `map[i]` = 下一个块节点的起始绝对 pos。`to = map[end-1] + 1`。

### 2. 后端 `proofread` 命令（Phase 1 已完成）
- `ai.rs`：`ProofreadItem` 结构 + `proofread_document(text, config)` + `build_proofread_prompt` + `parse_proofread_response` + `char_find`（字符空间查找）+ `strip_code_fences`。
- `commands.rs`：`proofread(text)` 命令，读全局 `state.ai_config`。
- `lib.rs`：`invoke_handler` 注册 `commands::proofread`。
- 强制 `thinking_enabled=false`、`max_tokens=8192`、`temperature=0.2`。
- 容错解析：剥 ```json 围栏→截取首个 `[...]`→解析失败返回空（不卡死）。

### 3. 前端 `proofreadStore`（pinia）
- state：`items: ProofreadIssue[]`、`correctWords: string[]`（localStorage 持久化、全局）、`loading`、`error`、`suppressed`。
- `runProofread(doc, from?, to?)`：构建 `{text, map}` → `invoke('proofread')` → 偏移映射为 `from/to` 存入 items（命中正词的项实时抑制）→ 打开面板。
- `ignore(id)` / `replace`（Phase 5）/ `addCorrectWord` / `removeCorrectWord` / `updateCorrectWord` / `clearAll`（清空 items 并关面板）。
- `remap(mapping)`：文档变更后调整 items 位置（删除命中编辑区间的项在 Phase 3 完善）。
- `initDoc(id)`：切文档时清空 `items`（不清 `correctWords`，全局）。

### 4. Decoration 红色波浪线（`RichEditor.vue`，Phase 3）
- 新增 `proofreadPlugin`（仿搜索高亮插件 645–661 行）：`DecorationSet` 存 `items` 的 `from/to`，class `proofread-underline`，CSS `text-decoration: underline wavy red`。
- docChanged 时重映射；编辑命中错误区间 → 删该项；多个 item 重叠 → 取并集。

### 5. 工具栏图标 + 触发（Phase 4）
- `RichEditor.vue` 的 `svg` 增加 `proofread`；靠近"插入批注"(2167 行)加按钮 `@mousedown.prevent="runProofread"`。
- 点击：无选区取全文，有选区取 `doc.textBetween(from,to)`。

### 6. 校对面板（集成抽屉，Phase 5/6/7）
- `compareStore.activeTab` 加 `'proofread'`；`CommentListPanel` 扩 tab+折叠 trigger（`hasProofread` 有结果才显示，带数量角标）。
- `ProofreadPanel.vue`：结果列表（跳转/替换/忽略/添加为正词）+ 正词管理器（增删改）+ 底部（一键替换逆序执行 / 清空收起）。
- 跳转：`editor.commands.setTextSelection(from)` + `scrollIntoView`；替换：`editor.chain().insertContentAt({from,to}, suggestion)`。

## 三、分阶段路线图

### Phase 1 — 后端 proofread 命令 ✅ 完成
- 改动：`ai.rs`(ProofreadItem + proofread_document + 解析容错)、`commands.rs`(proofread 命令)、`lib.rs`(注册)。
- 坑：字符 vs 字节（自实现 `char_find`）；长文 `max_tokens` 截断（Phase 8 分块）；推理模型偶发前缀（取首个 `[` 兜底）。
- ☐ ProofreadItem ☐ proofread_document ☐ proofread 命令 ☐ lib.rs 注册 ☐ JSON 容错解析 + 偏移重定位

### Phase 2 — proofreadStore + 偏移映射工具（进行中）
- 技术细节：`docOffset.ts`(buildPlainTextAndMap / buildPlainTextAndMapRange / offsetToRange)；`proofreadStore.ts`(items/正词/loading/runProofread/clearAll/initDoc/remap)；`compareStore.activeTab` 联合类型加 `'proofread'`。
- 坑：分隔符必须和 LLM 输入文本完全一致 → 统一封装 `buildPlainTextAndMap*`；选区模式偏移以区间起点为基准。
- 注意事项：`correctWords` 持久化；`initDoc` 只清 items 不清正词。
- ☐ docOffset 工具 ☐ store ☐ activeTab 扩展 ☐ initDoc 钩子（Phase 3/5 接线）☐ 映射自检

### Phase 3 — Decoration 红色波浪线（✅ 完成）
- 改动：`RichEditor.vue` 新增 `ProofreadExt`（仿 `SearchHighlightExt`），`proofreadPluginKey` 存波浪线 `DecorationSet`；docChanged 时 `old.map(tr.mapping, tr.doc)` 重映射；`Vue.watch(proofreadStore.items)` 变化即 `rebuildProofreadDecorations()` 重建。
- 装饰：`Decoration.inline(from, to, { class:'proofread-underline', 'data-proofread-id': id })`，CSS `text-decoration: underline wavy #ef4444`（深色 `#f87171`）。
- 编辑即删：在 `onUpdate` 中计算 `transaction.mapping.maps` 的变更区间（旧坐标），与 items 求交，命中即 `ignore`；存活项 `remap(transaction.mapping)` 重映射。
- hover 浮层：复用 `handleDOMEvents` 的 `mouseover/mouseout`，对 `.proofread-underline` 查 `data-proofread-id` 显示建议/原因小浮层。
- 坑：`old.map` 与 watch 重建都用同一份 store 数据，二者一致无冲突；docChanged 后 store 坐标若不更新，下次 rebuild 会错位 → 故 onUpdate 必须同步 remap。
- ☐ 插件 ✅ ☐ CSS ✅ ☐ 重映射 ✅ ☐ 编辑即删 ✅ ☐ hover 浮层 ✅ ☐ 视觉验证（待端到端）

### Phase 4 — 工具栏图标 + 触发（✅ 完成）
- 改动：`svg.proofread`（放大镜+对勾）；工具栏在"插入批注"后加按钮，`@mousedown.prevent="runProofreadAction"`，`btnClass(proofreadActive)`（loading 或面板打开时高亮）。
- `runProofreadAction`：无选区→`runProofread(doc)` 全文；有选区→`runProofread(doc, from, to)` 选区。
- 坑：结果回来后由 store 自动打开面板并切 `activeTab='proofread'`；未配置 key 时 `proofreadStore.error` 会有提示文案（面板/提示待 Phase 5 展示）。
- ☐ 图标 ✅ ☐ 按钮 ✅ ☐ loading 高亮 ✅ ☐ 选区/全文 ✅ ☐ 未配置提示（文案已有，UI 待 Phase 5）

### Phase 5 — 校对面板集成（✅ 完成）
- 改动：`CommentListPanel.vue` 把 `proofread` 作为第三个 section 接入统一抽屉。
  - `hasAny` 加入 `hasProofread`；`showTabs` = 存在 section 数 > 1 时显示 tab 栏（批注/比对/校对三选 N）。
  - 头部 tab 栏用 `v-if` 按存在性渲染三个 `panel-tab`；单 section 时退化为原标题风格（含校对专属标题）。
  - 内容区：批注(`v-show activeTab==='comment'`)、校对(`v-show activeTab==='proofread'`)、比对(`v-show activeTab==='compare'`) 三者并列。
  - 校对列表项：类别徽标 + `原文 → 建议` + 原因 + 操作（📍跳转 / ✎替换 / ✓正词 / 忽略）。
  - 正词管理：可折叠区块，列出/删除现有正词，输入框回车或"添加"新增；新增后会自动把命中该项的结果从列表移除。
  - 校对底部："🗑 清空校对结果"（调 `proofreadStore.clearAll()` → 清 items + 收起面板 + trigger 消失）。
  - trigger（面板关闭时）：`visibleTriggers` 按存在顺序动态 `top` 排列（间距 56px），三入口各带数量徽标（校对徽标红）。
- 交互桥接：`CommentListPanel` 新增 `emit('jumpProofread'|'replaceProofread')`，`RichEditor` 的 `<CommentListPanel>` 接这两个事件。
  - `onProofreadJump(id)`：查 issue → `setTextSelection({from,to})` + `domAtPos(from).scrollIntoView`。
  - `onProofreadReplace(id)`：`ed.chain().focus().setTextSelection({from,to}).insertContent(suggestion).run()`；插入触发 docChanged → 编辑即删（区间命中自动 `ignore`）+ 存活项 `remap`。
- `initDoc` 接线：`RichEditor` 新增 `watch(() => docStore.currentDocId, id => proofreadStore.initDoc(id))`；切文档即清校对结果（正词全局不清）。
- 坑：
  - 替换后区间文本变化，但 `onUpdate` 的 `mapping.maps` 旧坐标求交能稳定命中被替换项 → 不会残留波浪线。
  - trigger 之前用 `_second` 硬编码第二位置，三位并存时改为 `v-for` + 动态 `top`，避免空位。
  - 单 section 时 `showTabs=false`，用 `v-else` 渲染校对专属标题，避免 tab 栏只剩一个按钮。
- ☐ 面板集成 ✅ ☐ 四操作 ✅ ☐ 跳转滚动 ✅ ☐ 正词管理 ✅ ☐ initDoc 接线 ✅ ☐ 视觉验证（待端到端）

### Phase 6 — 正词管理器（✅ 完成，内嵌于校对面板）
- 见 Phase 5 的"正词管理"区块：增/删均经 `proofreadStore.addCorrectWord/removeCorrectWord`，持久化到 `localStorage(aipen_proofread_correct_words)`；新增即抑制命中结果的误报。
- ☐ 列表 ☐ 增删改 ☐ 实时抑制 ☐ 持久化

### Phase 7 — 一键替换 / 清空收起（待开始）
- ☐ 一键替换(逆序) ☐ 清空收起 ☐ 失败处理

### Phase 8 — 联调 / 边界 / 隐私（待开始）
- ☐ 长文分块 ☐ 空/特殊文档 ☐ 隐私提示 ☐ 端到端走查

## 四、总 Checklist
- ☐ 后端 proofread_document + 命令 + 注册 + 容错解析
- ☐ docOffset 偏移映射工具
- ☐ proofreadStore(items/正词/面板态/initDoc)
- ☐ proofreadPlugin 红色波浪线 + 重映射 + 编辑即删
- ☐ 工具栏图标 + 触发 + loading + 未配置提示
- ☐ 校对面板集成进统一抽屉
- ☐ 跳转 / 替换 / 忽略 / 添加正词
- ☐ 正词管理器(增删改 + 实时抑制 + 持久化)
- ☐ 一键替换(逆序) + 清空收起
- ☐ 长文分块 / 边界 / 隐私明示
- ☐ 端到端走查 + 深色模式验证
