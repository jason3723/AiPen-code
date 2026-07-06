# 左侧「浏览器」面板功能参考

> 本文档列出浏览器面板的完整功能清单，供修改代码时参考。
> 最后更新：2026-07-06

---

## 架构概览

浏览器面板通过 **Tauri 多窗口** 实现：一个独立的无边框、置顶 WebView2 窗口被精确定位在主窗口编辑区上方，模拟"内嵌浏览器"效果。

### 关键文件

| 文件 | 角色 |
|---|---|
| `src/views/EditorView.vue` | 浏览器所有前端逻辑、状态管理、事件监听和模板 |
| `src/components/MaterialPanel.vue` | 左侧栏面板，"浏览器" Tab 下的书签管理 UI |
| `src/stores/materialStore.ts` | 书签数据的 Pinia store |
| `src-tauri/src/commands.rs` | Rust 后端命令 + `BROWSER_INIT_SCRIPT` 注入脚本 |
| `src-tauri/src/lib.rs` | 浏览器命令注册、自定义协议处理、去重逻辑 |
| `src-tauri/capabilities/browser.json` | 浏览器窗口 Tauri capability 配置 |

---

## 左侧栏「浏览器」Tab

文件：`src/components/MaterialPanel.vue`

### 1. 书签添加

- **输入 URL**：文本框输入网址，按 Enter 或点击按钮添加
- **输入书签名称**：可选标题字段，默认显示 URL
- **添加书签按钮**：调用 `materialStore.addBookmark(url, title)` 持久化到 SQLite

```191:208:src/components/MaterialPanel.vue
// 书签添加相关代码
```

### 2. 书签列表

- 展示所有书签，每项显示：图标 + 标题 + URL
- **点击书签**：`emit("update", "openBrowser", url)` → 打开对应网址
- **删除书签**：悬停显示 ✕ 按钮 → `materialStore.deleteBookmark(bm.id)`
- **空状态**："暂无书签" + "输入网址添加常用参考页面"

### 3. 书签数据层

文件：`src/stores/materialStore.ts`

- `Bookmark` 接口：`{ id, url, title, created_at, updated_at }`
- `loadBookmarks()`：从后端加载全部书签
- `addBookmark(url, title)`：新增书签（插入列表头部）
- `deleteBookmark(bmId)`：删除书签
- 初始化时通过 `materialStore.init()` 一并加载

---

## 嵌入式 WebView 浏览器

文件：`src/views/EditorView.vue` (前端) + `src-tauri/src/commands.rs` (后端)

### 4. 浏览器窗口创建

**前端** (`EditorView.vue`)：

- 状态变量：`browserOpen`、`browserUrl`、`browserUrlInput`、`browserManuallyHidden`
- `handleOpenBrowser(url)`：自动补全 `https://` 前缀；若已存在则重定位 + 显示 + 导航；否则创建新窗口

**Rust 后端** (`commands.rs`)：

- `create_browser_webview`：先关闭已有窗口，计算逻辑坐标（主窗口位置 + DPI 缩放 + 偏移）
- 创建无边框 `WebviewWindow`：`decorations(false)`, `shadow(false)`, `skip_taskbar(true)`, `always_on_top(true)`, `resizable(true)`
- 设置桌面 Chrome UA 防止被网站拒绝访问
- 注入初始化脚本 `BROWSER_INIT_SCRIPT`
- 注册 `on_navigation` 拦截自定义协议 `aipen-clip.internal`

### 5. 地址栏导航

模板中的浏览器工具栏：

| 按钮 | 功能 | 对应命令 |
|---|---|---|
| 后退 | 返回上一页 | `navigate_browser_back` → `history.back()` |
| 前进 | 前进到下一页 | `navigate_browser_forward` → `history.forward()` |
| 刷新 | 重新加载页面 | `navigate_browser_refresh` → `location.reload()` |
| URL 输入框 | 输入网址，按 Enter 导航 | `navigate_browser` |
| 前往 | 触发导航 | `navigate_browser` |
| 关闭 | 销毁浏览器窗口释放资源 | `close_browser` |

Rust 命令清单：

- `navigate_browser`
- `navigate_browser_back`
- `navigate_browser_forward`
- `navigate_browser_refresh`
- `close_browser`
- `hide_browser`
- `show_browser`
- `resize_browser_webview`
- `set_browser_theme`

### 6. 空状态提示

浏览器未打开时显示占位：
- "浏览器模式"
- "在上方地址栏输入网址，或点击左侧书签打开 WebView"
- "选择「文档」Tab 返回编辑器"

---

## BROWSER_INIT_SCRIPT 注入脚本

文件：`src-tauri/src/commands.rs`

这是注入到每个被浏览网页中的 JavaScript，提供三大功能块：

### 7. 网页框架边框注入

- 注入 CSS 给 `<html>` 添加细边框，与地址栏底部边框风格一致
- 支持浅色/深色模式自适应

### 8. 拦截外部链接

- 劫持 `window.open`，重定向到当前页面（防止弹出新窗口）
- 全局 click 事件捕获，拦截所有 `target="_blank"` 的 `<a>` 标签
- 防止网站尝试在新窗口中打开链接

### 9. 自定义右键菜单

用户选中网页文本后右键弹出自定义菜单，包含三项：

| 菜单项 | 功能 |
|---|---|
| 📦 存入 AiPen 素材库 | 选中文本 + URL + 标题 → 打开素材剪藏弹窗 |
| 💬 添加到 AI 对话 | 选中文本 → 注入到 Chat 输入框，自动切换到 chat Tab |
| 复制 (Ctrl+C) | `navigator.clipboard.writeText` 复制到剪贴板 |

菜单特性：
- 浅色/深色主题自适应
- 毛玻璃效果 (`backdrop-filter: blur`)
- 点击遮罩层关闭菜单
- 防重复注册 (`__aipenContextMenuInstalled` 标志)
- 双重保险：立即注册 + `DOMContentLoaded` 注册

### 10. 双通道数据传输

剪藏和添加到对话通过双通道并行传输：

- **通道 1**：`window.__TAURI__.event.emit('browser-clip-selected-text', {...})` 直接 IPC
- **通道 2**：URL 导航到 `https://aipen-clip.internal/save/<base64>` 触发 `on_navigation` 拦截

### 11. 去重机制

- **Rust 端**：全局 `Mutex<(String, Instant)>` 缓存，5 秒内相同 payload 只处理一次
- **前端**：`_lastClipText` + `_lastClipTime`，1 秒内相同文本只处理一次
- 双通道同时触发时，双层去重确保只处理一次

### 12. 素材剪藏

选中文本 → 右键"存入 AiPen 素材库" → 隐藏浏览器 → 弹出素材剪藏对话框 → 完成后恢复浏览器

### 13. 添加到 AI 对话

选中文本 → 右键"💬 添加到 AI 对话" → 文本注入到右侧 AI 对话框输入区 → 自动切换到 Chat Tab

---

## 浏览器窗口生命周期管理

文件：`src/views/EditorView.vue`

### 14. Tab 切换 — 显示/隐藏

- 切换到 `browser` Tab → 先 `resize` 再 `show_browser`
- 切离 `browser` Tab → `hide_browser`（保留 webview 状态，不销毁）

### 15. 窗口大小/移动同步

- 监听 `window.resize` 事件 → 150ms 节流后调用 `resize_browser_webview`
- 监听 `onMoved` 事件 → 同样调用重定位
- 缩放过渡期间 (`isResizing`) 跳过，防止闪烁

### 16. 主窗口焦点同步

- 主窗口获焦 → 显示浏览器 + 重定位
- 主窗口最小化 → 隐藏浏览器
- Rust 端：浏览器窗口失焦 + 主窗口也失焦 → 自动隐藏浏览器

### 17. 主题同步

- 监听 `isDark` 变化 → `set_browser_theme` 同步到浏览器窗口：
  - 设置 `window.__aipenTheme` 为 `"dark"` 或 `"light"`

### 18. 窗口控制协调

| 场景 | 行为 |
|---|---|
| 最小化主窗口 | 先 `hide_browser` 再最小化 |
| 退出确认 | 隐藏浏览器 → 弹窗 → 确认则退出，取消则恢复 |
| 剪藏弹窗 | 隐藏浏览器 → 弹窗操作 → 完成后恢复显示 |

---

## 其他关键配置

### 19. 桌面 UA 伪装

- 设置 Chrome 132 User-Agent 字符串，防止网站因为 WebView UA 而拒绝服务

### 20. 跳过任务栏

- 浏览器窗口设置 `skip_taskbar(true)`，不会出现在 Windows 任务栏

### 21. 自定义协议

- 注册 `aipen-clip.localhost` 自定义协议，处理 `/save/<base64>` 路径
- base64 解码 → JSON 解析 → 去重检查 → emit 事件 + eval 全局函数 → 隐藏浏览器

### 22. Capability 配置

文件：`src-tauri/capabilities/browser.json`
- `core:event:allow-emit` / `core:event:allow-listen`
- `opener:allow-open-url` / `opener:allow-default-urls`

---

## 快速功能索引

| # | 功能 | 前端位置 | 后端位置 |
|---|---|---|---|
| 1 | 书签管理 (增/删/查/点) | `MaterialPanel.vue` | `commands.rs` 书签命令 |
| 2 | 书签 SQLite 持久化 | `materialStore.ts` | `commands.rs` / `db.rs` |
| 3 | WebView 窗口创建 | `EditorView.vue` `handleOpenBrowser` | `commands.rs` `create_browser_webview` |
| 4 | 地址栏 URL 导航 | `EditorView.vue` 工具栏模板 | `commands.rs` `navigate_browser` |
| 5 | 后退/前进/刷新 | `EditorView.vue` 按钮 | `commands.rs` 对应命令 |
| 6 | 关闭/销毁浏览器 | `EditorView.vue` 关闭按钮 | `commands.rs` `close_browser` |
| 7 | Tab 切换显示/隐藏 | `EditorView.vue` `leftSubTab` watch | `commands.rs` `hide/show_browser` |
| 8 | 窗口跟随定位 | `EditorView.vue` resize/move 事件 | `commands.rs` `resize_browser_webview` |
| 9 | 焦点联动 | `EditorView.vue` focus/minimize 事件 | `commands.rs` 失焦处理 |
| 10 | 主题同步 | `EditorView.vue` `isDark` watch | `commands.rs` `set_browser_theme` |
| 11 | 右键菜单注入 | — | `commands.rs` `BROWSER_INIT_SCRIPT` |
| 12 | 素材剪藏 | `EditorView.vue` 剪藏弹窗 | `commands.rs` `decode_and_emit` |
| 13 | 添加到 AI 对话 | `EditorView.vue` 注入逻辑 | `commands.rs` clip 处理 |
| 14 | 双通道数据传输 | — | `commands.rs` + `lib.rs` |
| 15 | 去重机制 | `EditorView.vue` 前端去重 | `lib.rs` Rust 去重 |
| 16 | 拦截 `target="_blank"` | — | `commands.rs` `BROWSER_INIT_SCRIPT` |
| 17 | 自定义协议处理 | — | `lib.rs` 协议注册 |
| 18 | 桌面 UA 伪装 | — | `commands.rs` 窗口创建 |
| 19 | 跳过任务栏 | — | `commands.rs` `skip_taskbar` |
| 20 | 窗口控制协调 | `EditorView.vue` 最小化/退出 | — |
