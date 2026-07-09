# 比对面板 技术方案 & 路线图

## 一、目标

在编辑器中添加**独立比对面板**，支持：
- 编辑器选中文本 → 右键 "加入比对"
- 素材库 / 外部任意文本 → 手动添加到比对面板
- 多条文本两两对比，Diff 结果在面板内渲染
- 与批注面板共用同一个抽屉容器，通过 **tab 切换**

---

## 二、当前架构基线

```
RichEditor.vue (body 区域，flex row)
├── <slot name="overlay" />          ← CandidatePanel
├── 大纲面板
├── <EditorContent />                ← TipTap 编辑器
└── <CommentListPanel />             ← 批注面板 (flex 子节点，右侧)
    ├── v-if="hasAny"                ← 有批注才渲染
    ├── open ref (local)             ← 折叠/展开状态
    ├── trigger 按钮                 ← v-show="!open"，translateX(-57%)
    └── 面板内容                    ← width: 0/280px transition
```

**关键文件**：
| 文件 | 作用 |
|---|---|
| `src/components/RichEditor.vue` | 编辑器主体，内嵌 CommentListPanel |
| `src/components/CommentListPanel.vue` | 批注抽屉（自管理 open、trigger、列表） |
| `src/utils/diff.ts` | Myers 字符级 diff（`computeDiff`, `DiffChunk[]`） |
| `src/components/DiffViewer.vue` | 版本对比渲染（参考其样式） |
| `src/stores/document.ts` | 文档 store（含 comments 管理） |

---

## 三、核心设计

### 3.1 交互模型

```
折叠态 (panelOpen = false)              展开态 (panelOpen = true)
═══════════════════════════════      ═══════════════════════════

                               ┌────────────────────────────┐
                               │ 📝 批注(3) │ 🔍 比对(2)  ✕│ ← tab 栏
      ┌──────────┐            ├────────────────────────────┤
      │ 📝  [3]  │  点任一    │                            │
      ├──────────┤ ──trigger─→│  CommentList               │
      │ 🔍  [2]  │            │  or                        │
      └──────────┘            │  CompareView               │
  trigger 按钮垂直排列        │                            │
  仅在有内容时显示            └────────────────────────────┘
```

**行为矩阵**：

| 操作 | 面板状态 | 结果 |
|---|---|---|
| 面板关闭 → 点批注 trigger | `open=true, tab=comment` |
| 面板关闭 → 点比对 trigger | `open=true, tab=compare` |
| 面板打开 → 点批注 tab | 切到 `tab=comment` |
| 面板打开 → 点比对 tab | 切到 `tab=compare` |
| 点当前激活的 tab | `open=false`（关闭面板） |
| 点 ✕ 关闭按钮 | `open=false` |
| 编辑器右键 "加入比对" | `open=true, tab=compare` + 自动添加条目 |
| 点评论角标 | `open=true, tab=comment`（现有逻辑不变） |

### 3.2 显示规则

| 场景 | 批注 trigger | 比对 trigger | 面板 tab 栏 |
|---|---|---|---|
| 有批注 + 有比对 | ✅ badge=3 | ✅ badge=2 | 双 tab |
| 有批注 + 无比对 | ✅ badge=3 | 隐藏 | 单 tab（批注） |
| 无批注 + 有比对 | 隐藏 | ✅ badge=2 | 单 tab（比对） |
| 无批注 + 无比对 | 隐藏 | 隐藏 | 面板不渲染 |

---

## 四、技术方案

### 4.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/stores/compareStore.ts` | 比对数据 store（entries、activePair、diffResult） |
| `src/components/CompareView.vue` | 比对面板内容（条目列表 + diff 结果） |

### 4.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/components/CommentListPanel.vue` | 重构为双 tab 抽屉（见 4.3） |
| `src/components/RichEditor.vue` | 右键菜单新增 "加入比对" |
| `src/components/MaterialPanel.vue` | 右键菜单新增 "加入比对"（如有） |

### 4.3 CommentListPanel 重构方案

```
当前：CommentListPanel.vue
  自包含：trigger 按钮 + 抽屉动画 + 批注列表

重构后：CommentListPanel.vue
  ├── trigger 区域（折叠态）
  │   ├── 批注 trigger（现有逻辑，有批注才显示）
  │   └── 比对 trigger（新增，有比对条目才显示）
  │
  └── 面板区域（展开态）
      ├── tab 栏（条件渲染：2 个 tab 才显示栏，1 个 tab 直接显示标题）
      │   ├── 📝 批注(N) 按钮
      │   ├── 🔍 比对(N) 按钮
      │   └── ✕ 关闭按钮
      │
      ├── 批注内容（activeTab === 'comment'）
      │   └── 现有评论列表逻辑不变
      │
      └── 比对内容（activeTab === 'compare'）
          └── <CompareView />
```

**状态管理变化**：

```diff
- const open = ref(false)              // 本地 ref

+ // 状态提升到父组件或 store 管理
+ // 方案：通过 Pinia compareStore 共享 state
+ import { useCompareStore } from '../stores/compareStore'
+ const compareStore = useCompareStore()
+
+ // 从 store 读取面板状态
+ const panelOpen = computed(() => compareStore.panelOpen)
+ const activeTab = computed(() => compareStore.activeTab)
+
+ function openTab(tab: 'comment' | 'compare') { ... }
+ function closePanel() { ... }
```

**Props 变化**：

```diff
  CommentListPanel
-  内部管理 open
+  props: 无变化（从 store 读取）

  emit: jump(commentId)  ← 保留
```

**决策：面板状态放在 compareStore 还是 documentStore？**

| 选项 | 优点 | 缺点 |
|---|---|---|
| compareStore | 语义清晰，比对相关状态集中 | 批注 panelOpen 却存在比对 store 里，有点奇怪 |
| documentStore | 批注相关状态已在此 | 比对状态混入文档 store |
| **新 hybridStore 或直接 compareStore** | **最小改动** | — |

**结论**：放 `compareStore`。`panelOpen` 和 `activeTab` 是面板级状态，虽然批注也要用到它，但改动面最小。批注的 open 是本地 ref，改为从 store 读取只需改 1 行引用。

### 4.4 compareStore 设计

```ts
// src/stores/compareStore.ts

interface CompareEntry {
  id: string
  label: string           // "编辑器选中" / "手动粘贴" / "素材库"
  text: string            // 纯文本
  createdAt: number
}

// 面板共享状态
interface CompareState {
  panelOpen: boolean
  activeTab: 'comment' | 'compare'

  entries: CompareEntry[]
  leftId: string | null   // diff 左值（默认第一个 entry）
  rightId: string | null  // diff 右值（默认第二个 entry）

  // 计算属性:
  // hasEntries → 控制 trigger 显示
  // hasAny → 控制面板是否渲染（hasComments || hasEntries）
  // diffResult → computed: computeDiff(left.text, right.text)
}
```

### 4.5 CompareView 组件设计

```
┌──────────────────────────────────────┐
│ 比对文本                              │
├──────────────────────────────────────┤
│ ┌──────────────────────────────┐     │
│ │ 📄 编辑器选中               ✕ │     │ ← 条目卡片（可删除）
│ │ Hello beautiful world...       │     │
│ └──────────────────────────────┘     │
│ ┌──────────────────────────────┐     │
│ │ 📋 手动粘贴                 ✕ │     │
│ │ Hello gorgeous world...        │     │
│ └──────────────────────────────┘     │
│                                      │
│ [+ 添加比对文本]                      │ ← 按钮
├──────────────────────────────────────┤
│ Diff 结果                             │
├──────────────────────────────────────┤
│ Hello ~~beautiful~~gorgeous world    │ ← 内联渲染
│         蓝色删除线   红色高亮          │
└──────────────────────────────────────┘
```

**交互**：
- 条目卡片可点击选择为 left/right
- 选中后自动触发 diff 计算
- 小于 2 个条目时，diff 结果区域显示 "请添加至少 2 条文本进行比对"
- "添加比对文本" → 弹出小型 textarea modal → 输入后点确认添加

### 4.6 Diff 结果渲染

复用 `src/utils/diff.ts` 的 `computeDiff()`：

```ts
import { computeDiff } from '../utils/diff'

// 组件内 computed
const diffResult = computed(() => {
  const left = entries.value.find(e => e.id === leftId.value)
  const right = entries.value.find(e => e.id === rightId.value)
  if (!left || !right) return null
  return computeDiff(left.text, right.text)
})
```

渲染模板：

```html
<template v-for="chunk in diffResult" :key="chunk.oldPos">
  <span v-if="chunk.kind === 'keep'">{{ chunk.oldText }}</span>
  <span v-else-if="chunk.kind === 'delete'"
    class="diff-del">{{ chunk.oldText }}</span>
  <span v-else-if="chunk.kind === 'insert'"
    class="diff-ins">{{ chunk.newText }}</span>
  <template v-else-if="chunk.kind === 'replace'">
    <span class="diff-del">{{ chunk.oldText }}</span>
    <span class="diff-ins">{{ chunk.newText }}</span>
  </template>
</template>
```

CSS（参考 DiffViewer 的翠绿/琥珀配色）：
```css
.diff-del {
  color: #3b82f6;
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  background: rgba(59, 130, 246, 0.06);
}
.diff-ins {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.08);
}
```

### 4.7 右键菜单集成

**RichEditor.vue** 已有 contextmenu handler（行 ~2270）。在文档模式菜单中新增：

```html
<!-- 在 "添加到候选库" 之后 -->
<div class="ctx-menu-item" @click.stop="addToCompare">
  <span>🔍 加入比对</span>
</div>
```

```ts
function addToCompare() {
  if (ctxMenuSelText.value) {
    compareStore.addEntry({
      text: ctxMenuSelText.value,
      label: '编辑器选中',
    })
    compareStore.openTab('compare')
  }
  closeCtxMenu()
}
```

菜单高度 `menuH` 需 `+28`。

**素材面板**：同理在素材模式右键菜单添加。

### 4.8 "添加比对文本" 弹窗

```
┌────────────────────────────┐
│  添加比对文本               │
│  ┌────────────────────────┐│
│  │                        ││
│  │  在此粘贴或输入文本...   ││
│  │                        ││
│  └────────────────────────┘│
│  标签: [编辑器选中  ▾]      │  ← 可选
│  [取消]            [添加]   │
└────────────────────────────┘
```

弹窗用 Teleport + fixed 定位，不引新组件库。

---

## 五、路线图

### Phase 1：基础设施（~2h）

**1.1 创建 compareStore** `src/stores/compareStore.ts`

```ts
- CompareEntry 接口
- entries: ref<CompareEntry[]>
- leftId / rightId
- panelOpen / activeTab
- hasEntries / hasAny computed
- diffResult computed（复用 computeDiff）
- addEntry(text, label)
- removeEntry(id)
- openTab(tab) / closePanel()
```

**1.2 创建 CompareView** `src/components/CompareView.vue`

```
- 条目列表渲染（卡片 + 删除按钮）
- "+ 添加比对文本" 按钮 + textarea 弹窗
- Diff 结果渲染（内联模式）
- 空状态提示
```

### Phase 2：面板重构（~3h）

**2.1 改造 CommentListPanel**

```
- open ref → 改为从 compareStore 读取 panelOpen
- activeTab 改为从 compareStore 读取
- 新增比对 trigger 按钮（v-if="hasCompareEntries"）
- 面板头部改为 tab 栏（条件渲染）
- 批注内容不变
- 比对内容区插入 <CompareView />
```

**2.2 CSS 调整**

```
- trigger 区域垂直双按钮布局
  ┌──────────┐
  │ 📝  [N]  │  top: 20px
  ├──────────┤  gap: 8px
  │ 🔍  [N]  │  top: 76px
  └──────────┘

- tab 栏 CSS（复用现有 panel-head 样式）
- 比对 trigger 的 hover / theme 样式
- 暗色模式适配
```

### Phase 3：编辑器集成（~1h）

**3.1 RichEditor 右键菜单**

```
- 文档模式：新增 "🔍 加入比对"
- 素材模式：新增 "🔍 加入比对"
- menuH 高度调整
```

**3.2 素材面板右键菜单**

```
- 新增 "加入比对" 选项
- 调用 compareStore.addEntry(text)
```

### Phase 4：细化 & 测试（~1h）

```
- 边界测试：空文本、超长文本、单条目
- 删除所有条目后 panel 自动关闭
- 暗色模式视觉校对
- 面板打开时点击编辑器空白处不关闭面板
- 确保不破坏现有批注功能
```

---

## 六、文件改动清单

```
新建:
  src/stores/compareStore.ts       (~100 行)
  src/components/CompareView.vue   (~200 行)

修改:
  src/components/CommentListPanel.vue   (~80 行改动)
  src/components/RichEditor.vue         (~30 行改动)
  src/stores/document.ts               (如需要 hasComments → compareStore 引用)

不修改:
  src/utils/diff.ts            (原封不动复用)
  src/components/DiffViewer.vue (参考样式，不改)
```

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| 面板状态从 local ref 升到 store 后，引用变化导致现有逻辑失效 | Phase 2 改造时保留 `computed` 桥接，确保"批注角标点击 → 自动打开面板"逻辑不破坏 |
| CompareView 内 diff 结果超长时面板滚动体验差 | Diff 结果区独立 `overflow-y: auto`，限制最大高度 |
| 两个 trigger 竖直排列后，空间不够或遮挡工具栏 | 当前编辑器右侧有足够空间（280px 面板宽度），trigger 只在折叠时占 28px 宽 |
| 批注无内容、比对有内容时，面板如何渲染 | 是合法场景，面板单 tab 模式渲染，不显示 tab 栏，只显示标题 + CompareView |

---

## 八、决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | 采用独立面板而非编辑器内联 diff | 避免 ProseMirror 位置映射复杂度，支持外部文本 |
| 2 | 面板状态存在 compareStore | 最小改动，批注本地 open ref 改 computed 即可 |
| 3 | 折叠态双 trigger / 展开态 tab 栏，双 UI 层互斥 | 避免折叠态→展开态的 trigger CSS 过渡难题 |
| 4 | 纯文本 diff，不保留格式 | 比对的本质是文字内容，不是排版 |
| 5 | 不做 "接受修改" | MVP 范围控制，用户手动修改 |
| 6 | trigger 有内容才显示 | 与批注 trigger 逻辑一致，无内容时界面干净 |
| 7 | 复用 DiffViewer 配色（蓝删除线 + 红高亮） | 但不复用其行级布局，改用内联渲染 |
