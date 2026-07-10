# 浏览器模块：真嵌入（Child WebView）+ WebView2 反检测 技术方案

> 版本：v1 | 日期：2026-07-09
> 关联文档：`browser-panel-reference.md`、`browser-owned-window-plan.md`（本方案将**替代并废止**后者）

---

## 一、背景与问题

### 1.1 当前架构的本质
浏览器模块目前是一个**独立的无边框 WebView2 窗口**（`WebviewWindow`，label=`browser`），通过 `SetWindowLongPtrW(GWLP_HWNDPARENT)` 挂成主窗口的 Owned Window，再用 `resize_browser_webview` 把物理坐标精确定位到编辑区上方，模拟"内嵌"。

### 1.2 代价
- 两个 OS 窗口 → 所有窗口行为（最小化跟随、Win+D、任务栏、resize 后 owner 重设、IME、焦点联动）都得靠 Rust 端 hack 协调（`browser-owned-window-plan.md` 正是在治理这些）。
- 这些是"两个窗口"架构的固有成本，无法根除，只能逐步修补。

### 1.3 UA 检测的局限
- 当前 UA 写死 `Chrome/132.0.0.0`，半年后即被"版本过旧"拦截。
- 仅伪装 UA 字符串不够：现代站点读 UA Client Hints（`navigator.userAgentData` / `Sec-CH-UA` 头）和 JS 指纹（plugins、languages 等），WebView2 在这些维度会露馅。
- **用户环境约束**：本机不装 Chrome、后两层（证书/功能硬限制）不存在 → 全部破解可在 WebView2 内部一条龙完成，**无需外部浏览器兜底**，也无需本机安装 Chrome。

---

## 二、目标

1. 浏览器成为**主窗口内的真嵌入子 WebView（child webview）**，与编辑区共享同一 OS 窗口句柄，窗口管理行为自动跟随主窗口，**彻底移除 owned-window 那套 hack**。
2. 基于 **WebView2 自身真实 Chromium 版本**动态伪装 UA + 伪造 client hints + 伪造 JS 指纹，绕过站点对 WebView2 的检测，**不依赖本机安装 Chrome**。
3. 完整保留现有功能：书签、剪藏双通道、自定义右键、主题自适应、`target=_blank` 拦截。
4. （增强）选中网页文字后弹出自定义浮动工具栏。

---

## 三、总体方案

```
           主窗口 (WebviewWindow "main", 单一 OS 窗口)
           ┌──────────────────────────────────────────┐
           │  ┌─ 主编辑区 WebView ─┐  ┌─ 右侧面板 ─┐  │
           │  │  (Vue 应用主体)    │  │           │  │
           │  └────────────────────┘  └───────────┘  │
           │  ┌─ child WebView "browser" ──────────┐ │  ← 真嵌入：同一 OS 窗口内第二个 webview 控件
           │  │  www.example.com (真实网页)        │ │
           │  └────────────────────────────────────┘ │
           └──────────────────────────────────────────┘
   移动/缩放/最小化/关闭/多屏/DPI → 全部由 OS 自动跟随，零 hack
```

两大部分：
- **模块 A（真嵌入）**：`WebviewWindow` → child `Webview`，用 `add_child` 定位。
- **模块 B（反检测）**：动态真实版本 UA + init script 增强（userAgentData 覆盖、指纹伪造、选中工具栏）。

---

## 四、模块 A：Child WebView 真嵌入

### 4.1 创建方式变更

`create_browser_webview` 由"新建独立窗口"改为"在主窗口内新建子 WebView"：

```rust
// 伪代码（以所用 Tauri 2.x 小版本 API 为准，POC 阶段核实）
let main = app.get_webview_window("main").ok_or("找不到主窗口")?;

// 计算编辑区在主窗口内的逻辑坐标 (x, y, w, h)
let (lx, ly, lw, lh) = compute_editor_rect(&main)?;

let child = tauri::webview::WebviewBuilder::new(
    "browser",
    tauri::WebviewUrl::External(parsed),
)
.user_agent(&real_chrome_ua)              // 见模块 B
.initialization_script(BROWSER_INIT_SCRIPT)
.on_navigation(move |url| { /* 双通道拦截，原逻辑照搬 */ })
.build(&main)                             // 挂到主窗口，返回 Webview（非 WebviewWindow）
.map_err(|e| format!("创建浏览器子 WebView 失败: {}", e))?;

main.add_child(&child, lx, ly, lw, lh)
    .map_err(|e| format!("定位浏览器子 WebView 失败: {}", e))?;
```

要点：
- `WebviewBuilder::build(&main)` 返回 `Webview`（不是 `WebviewWindow`）。后续所有 `app.get_webview_window("browser")` 需改为 `app.get_webview("browser")`。
- child webview 与主 webview 是**同一 OS 窗口**下的两个渲染控件，坐标基于主窗口客户区（逻辑像素），不再需要 `main.inner_position() + scale` 换算屏幕坐标。
- 移动主窗口、Win+D、多屏拖动、DPI 变更 → **OS 自动跟随**，删除 `set_browser_as_owned`、focus 同步、resize 重设 owner 等全部逻辑。

### 4.2 Tab 切换的范式变化（关键）

独立窗口可 `hide()`/`show()`；**child webview 不能独立隐藏**（它是父窗口的一部分，无 `hide`/`show`）。Tab 切换需换策略，二选一：

- **策略 X（推荐，零状态丢失）**：隐藏时把 child 移到主窗口客户区外（负坐标）或尺寸置 0；显示时移回编辑区。代价：零尺寸/移出可能触发某些页面 resize 逻辑，需验证。
- **策略 Y（实现简单）**：隐藏即 `child.destroy()`，切回 Tab 时按保存的 URL 重建。代价：丢页面状态（登录态/滚动位置），需把当前 URL 持久化以便重建。

建议 POC 先验证策略 X；若页面异常则退回策略 Y。

### 4.3 定位与 resize

- `resize_browser_webview` 保留，但操作对象由 `WebviewWindow` 改为 `Webview`，调用 `child.set_position(Position::Logical((x,y)))` + `child.set_size(Size::Logical((w,h)))`。
- 主窗口 resize / 折叠面板 / 全屏时，重新计算编辑区矩形并调用上述方法；不再需要 `transitionend` 兜底的 owner 重设（因为本来就在窗口内）。

### 4.4 与 `browser-owned-window-plan.md` 的关系

本方案**替代并废止** `browser-owned-window-plan.md`。owned-window 的所有逻辑（`set_browser_as_owned`、`resize` 重设、`show` 获焦、`close` 解绑）在 child webview 下不再需要，应从 `commands.rs` 移除。

### 4.5 剪藏 / 全屏场景

- 剪藏弹窗是主 webview 内的 Vue 弹窗。需确保它在 z-order 上覆盖 child webview：主 webview 应与 child webview 建立正确叠加顺序（Tauri `add_child` 顺序 / `WebviewWindow` 层控制）。若无法用 DOM 盖住，剪藏时改用策略 Y 临时销毁浏览器，完成后再重建（沿用现有 hide 语义）。
- 全屏（沉浸模式）：编辑区铺满，child webview 跟随 resize 到全屏区域即可。

---

## 五、模块 B：WebView2 反检测

### 5.1 真实版本号获取（Rust 端，Windows）

WebView2 Runtime 自身携带真实 Chromium 版本。创建前从注册表读取（同步、零依赖）：

```rust
#[cfg(target_os = "windows")]
fn webview2_chrome_version() -> String {
    // 读取 WebView2 Runtime 版本（EdgeUpdate 客户端 GUID）
    // HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-88FE64B1DBE5} 的 pv
    // 失败则回退 "132.0.0.0"
}
```

### 5.2 Rust 端 UA（解决请求头）

用真实版本构造**纯 Chrome UA**（去掉 `Edg/` 与任何 WebView 特征）：

```rust
let ver = webview2_chrome_version();
let ua = format!(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
   (KHTML, like Gecko) Chrome/{} Safari/537.36", ver);
// 传给 WebviewBuilder::user_agent(&ua)
```

### 5.3 init script 增强（解决 JS 层）

在 `BROWSER_INIT_SCRIPT` 增加一块"反检测"：

```js
// ── 0. 反检测：版本提取 + client hints + 指纹伪造 ──
(function () {
  try {
    var m = navigator.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    var ver = m ? m[1] : '132.0.0.0';
    // userAgentData 覆盖（骗过页面内 JS 检测；请求头 Sec-CH-UA 由 Rust UA 兜底）
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: function () { return {
        brands: [
          { brand: 'Chrome', version: ver.split('.')[0] },
          { brand: 'Not A(Brand', version: '24' },
          { brand: 'Chromium', version: ver.split('.')[0] }
        ],
        mobile: false, platform: 'Windows',
        getHighEntropyValues: function () { return Promise.resolve({}); }
      }; }
    });
    // 指纹伪造
    Object.defineProperty(navigator, 'plugins', { configurable: true, get: function () {
      return [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
    }});
    Object.defineProperty(navigator, 'languages', { configurable: true, get: function () {
      return ['zh-CN', 'zh', 'en-US', 'en'];
    }});
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: function () { return 0; }});
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
  } catch (e) {}
})();
```

> 注：因 Rust 端 UA 已是纯 Chrome 串，JS 层 `navigator.userAgent` 本身已干净，无需再覆盖；重点是补齐 `userAgentData` 与指纹。

### 5.4 UA Client Hints 请求头的难点（如实记录）

JS 覆盖只能改页面内读取，**改不了 WebView2 发出的 `Sec-CH-UA` 请求头**。要彻底改请求头，需 Rust 端在 `NavigationStarting` / 资源请求事件里改头，或升级 WebView2 环境参数。Tauri 2 对此控制有限，列为"已知不完美项"——但仅 JS 层 + 请求头 UA 伪装已能过绝大多数站点（含 Cloudflare 挑战页）。

### 5.5 选中文字浮动工具栏（增强项）

在 init script 增加 `selectionchange` / `mouseup` 监听：存在非空选区时，在选区上方插入浮动工具栏 DOM（复用现有右键菜单的配色/毛玻璃样式），提供"存入素材库 / 添加到对话 / 复制"等按钮，点击走现有双通道逻辑。这是"自定义右键"之外的第二种交互，纯前端、零 Rust 改动。

---

## 六、改动文件清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `src-tauri/src/commands.rs` | 改 `create_browser_webview`（WebviewBuilder+add_child） | 模块 A 核心 |
| `src-tauri/src/commands.rs` | 删除 `set_browser_as_owned` 及所有调用 | 移除 owned-window hack |
| `src-tauri/src/commands.rs` | `get_webview_window("browser")` → `get_webview("browser")` | child 是 Webview 类型 |
| `src-tauri/src/commands.rs` | `resize_browser_webview` 改用 set_position/set_size | 模块 A.3 |
| `src-tauri/src/commands.rs` | 新增 `webview2_chrome_version()` 注册表读取 | 模块 B.1 |
| `src-tauri/src/commands.rs` | `BROWSER_INIT_SCRIPT` 增加反检测块 + 选中工具栏 | 模块 B.3/B.5 |
| `src/views/EditorView.vue` | Tab 切换改为策略 X/Y；移除 focus/owner 同步逻辑 | 模块 A.2/A.4 |
| `src-tauri/capabilities/browser.json` | 权限按需调整（child webview 权限模型可能不同） | 验证 |

---

## 七、风险与验证

- [R1] child webview 的 `hide/show` 不存在 → 用策略 X/Y 规避（POC 先验）。
- [R2] child webview z-order：主 webview 弹窗能否盖住 child → POC 验证剪藏场景。
- [R3] `Sec-CH-UA` 请求头无法伪造 → 接受"JS 层 + UA 字符串"方案，实测 Cloudflare 类站点。
- [R4] 平台支持：child webview 在 Windows（WebView2）原生支持；macOS/Linux 支持度不同，需确认。本项目当前以 Windows 为主，可先 `#[cfg(windows)]` 实现。
- [R5] 注册表读取失败回退版本号，避免崩溃。

---

## 八、路线图

### 阶段 0 — POC 验证（2~3 天）
- 仅做最小 child webview：在编辑区创建一个能加载固定网址的 child webview，确认：能创建、能定位、能 navigate、能 eval、主窗口移动自动跟随。
- 验证 R1（隐藏策略）、R2（z-order）、R4（平台）。
- 反检测先用写死版本跑通 init script 注入，确认 `navigator.userAgentData`/`plugins` 覆盖生效。
- 产出：Go / No-Go 决策闸门。

### 阶段 1 — 真嵌入改造（3~5 天）
- 完整替换 `create_browser_webview` 为 child webview（含真实版本 UA）。
- 移除 `set_browser_as_owned` 全链路；`EditorView.vue` 移除 focus/owner 同步。
- `resize_browser_webview` 改为 child 定位。
- 双通道剪藏/对话逻辑原样迁移（`on_navigation` 照搬）。
- 跑通：书签、剪藏、Tab 切换、全屏、折叠、最小化、退出。

### 阶段 2 — 反检测增强（2~3 天）
- `webview2_chrome_version()` 注册表读取 + 动态 UA。
- init script 反检测块完整化（userAgentData + 指纹）。
- 实测若干"会拦 WebView"的站点（含 Cloudflare 挑战页），记录通过率。
- 更新文档：标记 `browser-owned-window-plan.md` 为废止。

### 阶段 3 — 选中浮动工具栏（2~3 天）
- init script 增加 `selectionchange` 浮动工具栏，复用右键菜单样式与双通道。
- 与现有右键菜单并存（选中即显工具栏；右键显菜单），可配置。

### 阶段 4 — 收尾与回归（1~2 天）
- 全量回归测试清单（基于现有验证清单迁移）。
- `cargo build --release` 无新增 warning。
- CHANGELOG 记录架构变更（独立窗口 → child webview）。

---

总估时：约 10~16 天（含 POC）。**阶段 0（POC）是 Go/No-Go 闸门，建议先单独交付**，确认 child webview 在 AiPen 环境下可用、z-order 与隐藏策略可行后，再推进后续阶段。
