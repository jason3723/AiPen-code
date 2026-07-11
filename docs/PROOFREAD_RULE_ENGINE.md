# AiPen 离线校对（规则引擎 + n-gram）技术方案

> 目标：在**不依赖大模型 AI、不产生任何 API 费用、不改动现有存储与编辑逻辑**的前提下，
> 为编辑器增加"错别字 / 标点 / 格式 / 同音词"的离线校对，并在 TipTap 上以「红色波浪线 + 悬浮建议 + 一键替换」呈现。
>
> 范围：**纯探讨落地的技术设计与实施路线**，本文件不包含任何功能代码改动。

---

## 0. 设计原则（最高优先级）

1. **零侵入存储层**：校对结果是**瞬态视图**，只活在 ProseMirror 的 `DecorationSet` 内存态里。
   - 不得写入 ProseMirror doc JSON、不得写入 `comments`、不得写入草稿（`save_draft`）、不得写入版本。
   - 复用现有 `serializeContent` / `parseContent` 时**校对数据完全不存在于其中**，与搜索高亮（`searchHighlightExt`）同级别。
2. **不破坏现有功能**：校验层只「读 doc + 画 Decoration」，除用户主动点「替换」外**绝不 dispatch 改变 doc 内容的 transaction**。
   - 与现有 `commentBadge`、`searchHighlightExt` 各自独立 `PluginKey`，互不干扰。
3. **默认关闭、可一键关停**：所有校对能力由一个开关 flag 控制，出现任何异常可立即关闭，不影响写作。
4. **纯离线**：规则层 100% 本地 JS；n-gram 层走 Rust 命令（本地模型文件），不出网、不调 API。

---

## 1. 现有可复用基础设施（已确认存在于代码）

| 能力 | 代码位置 | 说明 |
|---|---|---|
| 文档内联高亮 Decoration | `src/components/RichEditor.vue` `SearchHighlightExt`（~643）+ `applySearchDecorations`（~688） | 用 `Decoration.inline` + `setMeta` 注入 `DecorationSet`，**本方案直接照抄该模式** |
| 文本叶子遍历 + 坐标定位 | `ed.state.doc.descendants((node,pos)=>…)`，搜索功能（~720） | 抽取纯文本并算出每个文本片段的真实 doc 位置 |
| 字符偏移 → doc 位置映射 | `textOffsetToDocPos()`（~1074） | **仅适用于单文本节点**，校对需改用 `descendants` 逐叶子累加（见坑 1） |
| 悬浮卡片 / widget 角标 | `CommentTooltip` + `commentBadge` 插件（`Decoration.widget`） | 悬浮建议 UI 可复用同类机制 |
| 编辑防抖 | `document.ts` 草稿自动保存防抖（~434，1s） | 校对触发复用该防抖节奏 |
| 后端命令通道 | `src-tauri/src/commands.rs` 大量 `invoke` 命令 | n-gram 阶段新增 `proofread(text)` 命令 |
| 只读模式 | `document.ts` ~428 `viewingVersionId` 控制 editor `readonly` | 历史版本查看时编辑器只读，校对应跳过或仅显示 |

---

## 2. 必须避免的坑（重点）

### 坑 1：位置映射跨 mark 不线性
- **现象**：文本被加粗 / 批注 / highlight 等 mark 打断后，纯文本拼接的 `offset` 与 ProseMirror `doc pos` **不是线性一一对应**。直接复用 `textOffsetToDocPos`（假设单文本节点）会导致标红位置错位，甚至标到隔壁段落。
- **正确做法**：像搜索功能那样，用 `doc.descendants` 逐 `text` 叶子遍历，记录每个叶子的 `{from, to, text}`，校对命中只在「某叶子内部」的字符偏移上计算，再 `leaf.from + offset` 得到真实 doc pos。**绝不**把整篇 `textContent` 拼成一条字符串再算偏移。

### 坑 2：Decoration 误变成 doc 内容
- **现象**：若用 `Mark` 而非 `Decoration` 来标红，mark 会进入 ProseMirror JSON，被 `serializeContent` 持久化、被复制粘贴带出、污染 `comments` 逻辑。
- **正确做法**：一律用 `Decoration.inline(from, to, {class:'proofread-error'})`，纯视图层。**不要**创建新的 ProseMirror `Mark`。

### 坑 3：触发 autosave / 版本污染
- **现象**：校对插件若 dispatch 了改变 `currentContent` 的 transaction，`document.ts` 的 `watch(currentContent)`（~415）会误判为「用户编辑」并触发 `save_draft`。
- **正确做法**：Decoration 注入用 `tr.setMeta(proofreadKey, decoSet)` 且 `decoSet` 不含 doc 变更 → 不会改 `tr.doc` → `watch` 不触发。替换动作是用户显式编辑，触发 autosave 属正常预期。

### 坑 4：同步重算卡住输入
- **现象**：每次按键都同步跑规则/n-gram，大文档下输入卡顿。
- **正确做法**：编辑后 **防抖（建议 600ms~1s）** 再跑；n-gram 走 Rust 不阻塞主线程；规则层对超长文档可只校验视口或分块。

### 坑 5：Decoration 在 docChanged 后失效/错位
- **现象**：用户继续输入，旧的 Decoration 坐标未跟随映射，标红跑到错误位置。
- **正确做法**：防抖到点后**整体重算**（文档体量可控）；若需增量，必须用 `tr.mapping.map(from/to)` 跟随。方案统一采用「防抖整体重算」最简且安全。

### 坑 6：与 comment / search 高亮打架
- **现象**：多个 Decoration 插件共用状态或 key 冲突，互相覆盖。
- **正确做法**：校对用**独立** `PluginKey('proofread')` + 独立 `DecorationSet`，与 `commentBadge` / `searchHighlightExt` 完全隔离（复制它们的隔离写法）。

### 坑 7：替换时用了过期坐标
- **现象**：用户先看到标红，期间文档已变，点击「替换」却替换了错误的位置。
- **正确做法**：点击时用**当前 doc** 重新定位该片段（或用 `tr.mapping` 跟踪），不要缓存旧 `from/to`。替换用 `editor.chain().insertContentAt({from,to}, suggestion).run()` 或 `replaceRange`。

### 坑 8：只读 / 历史版本态误触发
- **现象**：查看历史版本（`viewingVersionId` 非空，editor readonly）时仍跑校对，造成无意义开销或交互异常。
- **正确做法**：`viewingVersionId` 非空时跳过校对计算；或对只读态只展示不交互。

### 坑 9：n-gram 模型文件体积 / 路径
- **现象**：语言模型文件几十 MB，若放错 Tauri resource 路径，dev / install 两种环境读取不一致（参考教程 `tutorial.md` 的双路径处理）。
- **正确做法**：模型/混淆词典放 `src-tauri/resources/`，通过 Rust command 读取，复用 `get_tutorial_markdown` 的 dev/prod 双路径思路。

---

## 3. 实施路线

### 阶段 0：骨架隔离（无行为，仅验证不破坏现有功能）
- 新增 `src/utils/proofread/types.ts`：定义 `ProofreadIssue { from,to,message,suggestion,ruleId,severity }` 与规则接口。
- 新增 `src/components/proofread/ProofreadExt.ts`：照搬 `SearchHighlightExt` 结构的空插件（`PluginKey('proofread')`，`init` 返回 `DecorationSet.empty`，`apply` 仅响应 meta，`props.decorations` 返回状态）。
- 在 editor 扩展列表注册该 Extension（默认 flag `proofreadEnabled=false`，关闭时直接不注册或装饰集恒空）。
- **阶段目标**：编辑器照常工作，无任何可见变化。

### 阶段 1：文本抽取 + 坐标映射（正确性核心）
- 新增 `src/utils/proofread/extractText.ts`：`extractTextSpans(doc) => {from,to,text}[]`，用 `doc.descendants` 遍历 `isText` 叶子，逐叶子记录。
- 写最小单测：对含加粗、批注 mark、多段落的 doc，验证 `from/to` 与 `text` 拼接回原文一致、且坐标正确。
- **阶段目标**：坐标 100% 准确（这是后续所有命中的地基）。

### 阶段 2：规则引擎（前端 JS，纯离线，最先可用）
- 实现规则集（每条约 10~30 行，纯函数 `（span)=>ProofreadIssue[]`）：
  1. 中文混用半角标点（`,` `.` `!` `?` `:` 等出现在 CJK 上下文）。
  2. 连续重复标点（`。。` `，，` `？？`）。
  3. 引号 / 书名号不配对（奇数个 `"` 或 `《` 无收尾）。
  4. 全半角混用（如数字用全角 `２`）。
  5. 空格中文化（CJK 间多余空格 / 西文后缺空格初步）。
  6. 简单同音/形近固定错（`的的` 冗余、`在再`、`即既` 等高频易错，仅做**确定性**清单，不做上下文消歧）。
  7. 常见语法模式（如 `通过…使…` 缺主语、`是否…能否…` 两可）。
- 把规则命中（叶子内字符偏移）→ 经 `span.from` 映射为 doc pos → 收集 `ProofreadIssue[]`。
- 防抖后通过 `setMeta(proofreadKey, DecorationSet.create(doc, issues.map(i=>Decoration.inline(i.from,i.to,{class:'proofread-error', 'data-rule':i.ruleId}))))` 注入。
- 新增 CSS：`.proofread-error { text-decoration: underline wavy red; text-underline-offset: 2px; }`。
- **阶段目标**：打字后约 1s，错别字/标点被波浪线标出。

### 阶段 3：悬浮建议 + 一键替换
- 监听 `proofread-error` 元素 `mouseenter` / 点击，弹出轻量 Popover（复用 `CommentTooltip` 样式），显示 `message` + 「替换为：suggestion」按钮 + 「忽略」。
- 「替换」执行 `insertContentAt({from,to}, suggestion)`（用**当前** doc 位置重定位，避坑 7）；「忽略」将该 `ruleId+text` 加入本会话忽略集（仅内存）。
- 替换/忽略后触发防抖重算。
- **阶段目标**：完整闭环「标红 → 看建议 → 改/忽略」可用。

### 阶段 4（第二阶段，可选）：n-gram 同音消歧（Rust 后端）
- 在 `src-tauri/resources/` 放混淆词典 + 轻量 n-gram 模型（或开源混淆集词表）。
- 新增 Rust 命令 `proofread(text: String) -> Vec<{offset,len,suggestion,message}>`，本地加载模型、按混淆集 + n-gram 打分返回**纯文本偏移**。
- 前端把 `extractTextSpans` 的纯文本（带叶子映射）发给命令，返回偏移按叶子映射回 doc pos，与阶段 2 的 `DecorationSet` **合并**展示。
- dev/prod 读取模型路径复用教程双路径模式（避坑 9）。
- **阶段目标**：`的/地/得`、`做/作` 等上下文相关同音错也能标出，仍全程离线。

---

## 4. 每阶段 Checklist

### 阶段 0 Checklist
- [ ] 新增 `ProofreadExt.ts`，结构与 `SearchHighlightExt` 一致，独立 `PluginKey('proofread')`。
- [ ] `proofreadEnabled=false` 时编辑器行为与改动前**逐字节一致**（无注册 / 装饰恒空）。
- [ ] 现有 comment 角标、搜索高亮、粘贴、保存、版本切换全部手动回归通过。
- [ ] lint 0 错误。

### 阶段 1 Checklist
- [ ] `extractTextSpans` 对「纯文本 / 加粗 / 批注 mark / 多段落 / 列表 / 表格」各场景返回坐标正确。
- [ ] 单测覆盖：拼接回原文一致；`from/to` 落在正确节点。
- [ ] 不改变任何渲染/存储。

### 阶段 2 Checklist
- [ ] 规则命中经 `span.from` 映射，标红位置与文字**完全对齐**（跨 mark 不偏移，验坑 1）。
- [ ] Decoration 为纯视图，**复制粘贴 / save_draft / 提交版本均不含校对数据**（验坑 2、3）。
- [ ] 编辑防抖生效，输入不卡顿（验坑 4）。
- [ ] docChanged 后防抖整体重算，旧标红不残留错位（验坑 5）。
- [ ] 与 comment/search 高亮同屏不冲突（验坑 6）。
- [ ] `viewingVersionId` 非空时跳过（验坑 8）。

### 阶段 3 Checklist
- [ ] 悬浮 Popover 显示 message 与建议，不遮挡输入。
- [ ] 「替换」用当前 doc 位置，连续多次替换不错位（验坑 7）。
- [ ] 「忽略」仅内存生效，刷新后重置（符合预期）。
- [ ] 替换后 autosave 正常触发（属预期用户编辑），无其他副作用。

### 阶段 4 Checklist（可选）
- [ ] 模型文件置于 `resources/`，dev 与 install 两种环境均能加载（验坑 9）。
- [ ] 命令返回纯文本偏移，前端映射回 doc pos 与阶段 2 合并展示。
- [ ] 全程离线，无任何网络请求 / API 调用。
- [ ] 大文档（>2万字）n-gram 阶段不阻塞主线程（Rust 侧、可加超时）。

---

## 5. 风险与回滚
- **总开关**：`proofreadEnabled` 默认 `false`，上线即关，灰度开启；任何异常直接置 `false` 即回到改动前行为。
- **隔离保证**：因校对数据从不进 `serializeContent` / `parseContent` / 草稿 / 版本，最坏情况只是「标红不准」，**绝不会损坏文档内容或历史版本**。
- **回滚成本**：阶段 0~3 全部为新增文件 + 一个独立 Extension 注册，撤销即删除，不影响任何既有逻辑。

---

## 6. 结论
- **规则层**：结合现有 TipTap `Decoration` 机制 + 文本遍历 + 位置映射，**实现成本低、风险极低**，且不碰存储层，1~2 天可出可用原型。
- **n-gram 层**：代码不难，主要成本是「准备中文纠错模型/混淆词典数据并打包」的数据工程，属第二阶段。
- **推荐路径**：先完成阶段 0~3 跑通规则层闭环，再视需求启动阶段 4。

---

## 7. 数据来源与授权（阶段 2 / 4 取材依据）

> 校对的核心是**数据**，不是代码。以下为可直接取用的开源资源，均离线可用。

### 7.1 规则层混淆词典（阶段 2，零模型）
最权威可直接抄的数据来自 **`shibing624/pycorrector`**（GitHub，Apache-2.0）仓库的 `pycorrector/data/` 目录，均为纯文本，转 JSON/TS 后打包进 `src-tauri/resources/` 或前端 `src/utils/proofread/data/`：

| 文件 | 内容 | 覆盖场景 | 体量 |
|---|---|---|---|
| `same_pinyin.txt` | 同音字混淆集（如 `de 的,地,得,…`） | 的/地/得、在/再、做/作、即/既 | 几十 KB |
| `similar_stroke.txt` | 形近字混淆集（如 `未,末`） | 未/末、巳/已/己 | 几十 KB |
| `custom_confusion.txt` | 词级混淆（如 `按装→安装`） | 常见词错写 | 几 KB |
| `word_freq.txt` | 词频表 | 多候选时"哪个更常见"打分 | 几 MB |

- 拼音→同音字映射亦可由 `pypinyin` 的拼音词典生成，不必手写。
- 国内下载不稳可用 **ModelScope（魔搭）** 上 shibing624 同名资源镜像。

### 7.2 n-gram 语言模型（阶段 4，做上下文同音消歧才需要）
仅 `的/地/得` 这类"字都对、放错位置"的上下文消歧需要；常见错别字用 7.1 已覆盖。

- **现成预训练**：`zh_giga.no_cna_cmn.prune.klm`（中文 4-gram，kenlm 格式，开源分发，pruned 后约 100~200 MB），多数中文纠错项目直接复用。
- **自训（可选）**：搜狗语料 / 人民日报语料 / 中文维基 + `kenlm` 工具训练，几分钟出模型。
- **在 AiPen 中的加载**：经 Rust 后端用 kenlm 的 Rust 绑定（或直接加载 `.klm` 做 n-gram 查表）打分，对应本方案阶段 4 的 Rust 命令；比浏览器跑 WASM 干净。

### 7.3 务实取材路径
1. 先只做阶段 2：引入 `same_pinyin.txt` + `similar_stroke.txt` + `word_freq.txt`，**全程零模型文件**，覆盖约 80% 常见错别字/标点。
2. 真要上下文消歧再上阶段 4：届时决定引 `zh_giga...klm`（现成但大）或自训小模型。

### 7.4 授权注意
- pycorrector 数据 Apache-2.0，可商用。
- `zh_giga` 模型源自学术语料，**发布前确认许可证**；自训语料注意各自版权。
- 所有数据文件随 `src-tauri/resources/` 分发，复用教程 `tutorial.md` 的 dev/install 双路径读取模式。
