# 浏览器窗口重构计划：`always_on_top` → Owned Window（修订版 v2）

> 目标：用 Windows OS 级别的"所属窗口（Owned Window）"关系替代 `always_on_top`，一次性消灭 4 类窗口管理 bug。
> 不改动任何业务逻辑（右键菜单、书签、剪藏、双通道、去重全部保持不变）。
> **本次修订**：补全上一版遗漏的 8 个关键坑（owner 关系在 resize 时被重置、WebView2 宿主行为、多显示器、alt+Tab、行为变更取舍、过渡时序、剪藏恢复顺序、回退方案）。

---

## 一、核心原理

```
改变前：                             改变后：
┌─ 主窗口 (normal) ──┐               ┌─ 主窗口 (owner) ──┐
│                     │               │  ┌─ 浏览器 (owned) ┐│
│  ┌─ always_on_top ─┐│               │  │ www.baidu.com  ││
│  │ www.baidu.com   ││               │  └────────────────┘│
│  └─────────────────┘│               └────────────────────┘
└─────────────────────┘
 ↑ 浏览器是独立窗口      →             ↑ 浏览器是主窗口的 Owned Window
   手动协调一切                            OS 自动管理 z-order / 最小化 / 销毁
```

Windows 中通过 `SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner_hwnd)` 建立 Owned Window 关系后：

| 特性 | 行为 | 对应的 bug |
|---|---|---|
| 最小化跟随 | owner 最小化时 owned 自动隐藏 | **修复 bug ④** |
| 恢复跟随 | owner 恢复时 owned 自动显示 | **修复 bug ④** |
| z-order | owned 始终在 owner 之上，其他窗口可覆盖 | **改善 bug ①②** |
| 销毁跟随 | owner 关闭时 owned 自动销毁 | 防止残留窗口 |
| 任务栏行为 | owned 跟随 owner 响应任务栏操作 | **修复 bug ③** |
| Win+D | owned 随 owner 一起隐藏 | **修复 bug ④** |

> ⚠️ **行为变更（要确认）**：`always_on_top` 是"永远在最上"，改为 owner 关系后**其他程序窗口（微信、终端、浏览器）可以盖住浏览器**。这是有意行为变更（"跟随主窗口"语义），但要确保用户接受。详见 §9。

---

## 二、改动文件清单

| 文件 | 改动性质 | 改动量 |
|---|---|---|
| `src-tauri/Cargo.toml` | 添加依赖 | +3 行 |
| `src-tauri/src/commands.rs` | 修改创建逻辑 + 简化失焦处理 + 多处补 owner 重设 | ~+55 行，-17 行 |
| `src-tauri/src/lib.rs` | 无改动 | 0 |
| `src/views/EditorView.vue` | 简化焦点/最小化逻辑，修复折叠同步 | ~-35 行，+20 行 |

> 实际净增比原计划多 ~20 行（owner 重设 + 多显示器保护 + 剪藏恢复顺序修正）。

---

## 三、具体改动

### 3.1 `src-tauri/Cargo.toml` — 添加依赖

在第 34 行（`base64 = "0.22"`）之后添加：

```toml
raw-window-handle = "0.6"
windows = { version = "0.58", features = [
    "Win32_UI_WindowsAndMessaging",
    "Win32_Foundation",
] }
```

> **注意**：`raw-window-handle` 必须和 Tauri 2 当前依赖的版本**严格对齐**——Tauri 2.1+ 用 `0.6`，Tauri 2.0 用 `0.5`。**在 `Cargo.lock` 里先 `cargo tree -i raw-window-handle` 看 Tauri 实际拉的版本**，用相同版本号写入，避免 lock 漂移。如果 Tauri 用 `^0.6`，这里用 `0.6` 即可（lock 文件会自动取兼容最高版）。

### 3.2 `src-tauri/src/commands.rs` — 核心改动

#### 3.2.1 文件顶部添加 use 语句

```rust
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowLongPtrW, GWLP_HWNDPARENT,
};
use windows::Win32::Foundation::HWND;
```

#### 3.2.2 添加辅助函数（关键：幂等 + 错误容忍）

```rust
/// 将 browser_window 设为 main_window 的 Owned Window
/// 效果：浏览器窗口自动跟随主窗口最小化/恢复，自动保持在上层
///
/// 注意：此函数**幂等**，可在多处反复调用以应对 wry/WebView2 内部重置 owner 的情况。
/// 见 §3.2.5 中 "owner 重设陷阱"。
fn set_browser_as_owned(
    main: &tauri::WebviewWindow,
    browser: &tauri::WebviewWindow,
) -> Result<(), String> {
    let main_hwnd = get_hwnd(main)?;
    let browser_hwnd = get_hwnd(browser)?;
    unsafe {
        // 失败不回退到 always_on_top（避免行为分叉），只 eprintln
        SetWindowLongPtrW(
            HWND(browser_hwnd),
            GWLP_HWNDPARENT,
            main_hwnd,
        );
    }
    Ok(())
}

fn get_hwnd(window: &tauri::WebviewWindow) -> Result<isize, String> {
    let wh = window.window_handle()
        .map_err(|e| format!("获取窗口句柄失败: {}", e))?;
    match wh.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get()),
        _ => Err("非 Windows 平台".to_string()),
    }
}
```

#### 3.2.3 修改 `create_browser_webview`

**改动点 A**：删除 `.always_on_top(true)` 行

```rust
// 删除这行：
.always_on_top(true)
```

**改动点 B**：在 `.build()` 成功后，注册 on_window_event 之前插入 owner 设置

```rust
let wv = tauri::WebviewWindowBuilder::new(...)
    // ... 原有配置（去掉 always_on_top）...
    .build()
    .map_err(|e| format!("创建浏览器窗口失败: {}", e))?;

// ★ 建立所属关系：浏览器窗口跟随主窗口
if let Some(main_win) = app.get_webview_window("main") {
    if let Err(e) = set_browser_as_owned(&main_win, &wv) {
        eprintln!("[Browser] 设置 owned window 失败: {}", e);
    }
}
```

**改动点 C**：删除失焦事件中的手动 `hide_browser` 逻辑

```rust
// 删除以下整个闭包（owned window 自动处理失焦场景）：
wv.on_window_event(move |event| {
    if let tauri::WindowEvent::Focused(false) = event {
        if let Some(main) = app_handle2.get_webview_window("main") {
            if let Ok(main_focused) = main.is_focused() {
                if !main_focused {
                    if let Some(wv) = app_handle2.get_webview_window("browser") {
                        let _ = wv.hide();
                    }
                }
            }
        }
    }
});
```

> owned window 自动跟随 owner 隐藏（点击程序外、Win+D），不再需要手动监听失焦。

**改动点 D**（新增）：resize 后重新建立 owner 关系（**关键防坑**）

在 `resize_browser_webview` 函数末尾（约第 2195 行）添加：

```rust
// ★ 防坑：Tauri/wry 内部可能通过 SetWindowPos 重置 z-order，
// 连带把 GWLP_HWNDPARENT 抹掉。重新建立 owner 关系保持幂等。
if let Ok(main_win) = app.get_webview_window("main") {
    if let Err(e) = set_browser_as_owned(&main_win, &wv) {
        eprintln!("[Browser] resize 后重设 owner 失败: {}", e);
    }
}
```

**改动点 E**（新增）：`close_browser` 中显式解绑 owner

在 `close_browser` 函数中，关闭前显式解绑（避免异步销毁时的窗口残留）：

```rust
#[tauri::command]
pub async fn close_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview_window("browser") {
        // ★ 防坑：显式解绑 owner 关系，避免异步销毁时序下 owner 关系卡住
        if let Ok(browser_hwnd) = get_hwnd(&wv) {
            unsafe {
                let _ = SetWindowLongPtrW(
                    HWND(browser_hwnd),
                    GWLP_HWNDPARENT,
                    HWND(std::ptr::null_mut()),
                );
            }
        }
        let _ = wv.close();
    }
    Ok(())
}
```

**改动点 F**（新增）：`show_browser` 中确认主窗口获焦（**关键顺序**）

在 `show_browser` 函数开头添加：

```rust
#[tauri::command]
pub async fn show_browser(app: tauri::AppHandle) -> Result<(), String> {
    // ★ 防坑：剪藏弹窗完成恢复时，必须先让主窗口获焦，
    // 否则 owned window 可能因 owner 处于"失焦态"被系统强制隐藏，
    // 随后 show_browser() 调用会被压住。
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.set_focus();
    }
    if let Some(wv) = app.get_webview_window("browser") {
        wv.show().map_err(|e| format!("显示浏览器失败: {}", e))?;
    }
    Ok(())
}
```

#### 3.2.4 `hide_browser` / 其他浏览器命令 — 保持不变

- `hide_browser`：剪藏弹窗时仍需手动隐藏浏览器窗口
- `navigate_browser` / `_back` / `_forward` / `_refresh`：保持不变
- `resize_browser_webview`：已通过改动点 D 增强
- `set_browser_theme`：保持不变

---

### 3.3 `src/views/EditorView.vue` — 前端简化与修复

#### 3.3.1 简化 `handleMinimize`（第 1051-1059 行）

Owned window 自动跟随主窗口最小化，不再需要手动 `hide_browser`：

```typescript
async function handleMinimize() {
  // owned window 自动跟随主窗口最小化，无需手动 hide_browser
  await getCurrentWindow().minimize();
}
```

#### 3.3.2 简化 `onFocusChanged`（第 1005-1027 行）

```typescript
focusUnlisten = await win.onFocusChanged(async ({ payload: focused }) => {
  if (isResizing.value) return;
  if (browserOpen.value && !browserManuallyHidden.value && leftSubTab.value === 'browser') {
    try {
      if (focused) {
        const minimized = await getCurrentWindow().isMinimized();
        if (!minimized) {
          const vp = getBrowserViewportRect();
          if (vp) {
            await invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height });
          }
          await invoke("show_browser");
        }
      }
      // 失焦时不再需要手动 hide——owned window 自动处理
    } catch { /* 忽略 */ }
  }
});
```

#### 3.3.3 `tryExit` 中保留 `hide_browser` 但简化判断

退出确认 dialog 是同步阻塞的、modal 的，**owned window 在主窗口弹出原生 dialog 时不会自动隐藏**。保留 `hide_browser`，但加注释：

```typescript
async function tryExit() {
  if (browserOpen.value) {
    browserManuallyHidden.value = true;
    // owned window 在 modal dialog 弹出时不会自动消失，仍需手动 hide
    try {
      await invoke("hide_browser");
    } catch { /* 忽略 */ }
  }
  // ... 弹窗逻辑 ...
}
```

#### 3.3.4 修复折叠/展开时的浏览器定位（新增）

**问题**：面板折叠/展开是 CSS transition 动画（~200ms），期间 `getBoundingClientRect()` 的值持续变化。

**修复方案**：监听 `transitionend` 强制 reposition。

```typescript
// 在 <script setup> 中添加：
const mainAreaRef = ref<HTMLElement | null>(null); // 已有

function syncBrowserPositionAfterTransition() {
  if (!browserOpen.value || leftSubTab.value !== 'browser') return;
  const vp = getBrowserViewportRect();
  if (!vp) return;
  invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height }).catch(() => {});
}

// onMounted 中追加：
mainAreaRef.value?.addEventListener('transitionend', syncBrowserPositionAfterTransition);

// onBeforeUnmount 中移除：
mainAreaRef.value?.removeEventListener('transitionend', syncBrowserPositionAfterTransition);
```

#### 3.3.5 修复全屏操作后浏览器定位（`handleToggleFullscreen`）

第 1086-1115 行，**改用 transitionend 而非 sleep(100)**（sleep 在低性能机器上不可靠）：

在 `handleToggleFullscreen` 末尾（`overlayVisible.value = false;` 之后）添加：

```typescript
// flushCompositorFrame 中已经设置 isResizing = false
// 通过 transitionend 等待面板动画完成（比 sleep 更可靠）
const mainEl = mainAreaRef.value;
if (mainEl) {
  const onEnd = (e: TransitionEvent) => {
    if (e.target === mainEl) {
      mainEl.removeEventListener('transitionend', onEnd);
      if (browserOpen.value && leftSubTab.value === 'browser') {
        const vp = getBrowserViewportRect();
        if (vp) {
          invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height }).catch(() => {});
        }
      }
    }
  };
  mainEl.addEventListener('transitionend', onEnd);
  // 兜底：400ms 后强制 reposition（防 transitionend 不触发）
  setTimeout(() => {
    mainEl.removeEventListener('transitionend', onEnd);
    if (browserOpen.value && leftSubTab.value === 'browser') {
      const vp = getBrowserViewportRect();
      if (vp) {
        invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height }).catch(() => {});
      }
    }
  }, 400);
}
```

#### 3.3.6 修复 `handleMaximize` 后的浏览器定位

在 `handleMaximize` 末尾（`overlayVisible.value = false;` 之后）添加同 3.3.5 的代码（可用 `syncBrowserPositionAfterTransition()` 复用）。

---

## 四、`lib.rs` — 不变

`register_uri_scheme_protocol` 中的 `hide_browser` + `set_focus` 逻辑在 owned window 架构下依然需要，**且 `set_focus` 比之前更重要**（见 3.2.6 改动点 F）。

---

## 五、`BROWSER_INIT_SCRIPT` — 不变

注入脚本中的右键菜单、`target="_blank"` 拦截、边框注入、双通道 `fetch` + `location` 发送逻辑全部保持不动。

---

## 六、`MaterialPanel.vue` / `materialStore.ts` — 不变

书签管理功能完全不受影响。

---

## 七、改动汇总

```
文件                             新增行    删除行    净变化
─────────────────────────────────────────────────────────
src-tauri/Cargo.toml                +3         0      +3
src-tauri/src/commands.rs          +55       -17     +38
src-tauri/src/lib.rs                 0         0       0
src/views/EditorView.vue           +35       -25     +10
─────────────────────────────────────────────────────────
合计                               +93       -42     +51
```

比 v1 版（净增 31 行）多 20 行，主要来自：
- `close_browser` / `show_browser` / `resize_browser_webview` 补 owner 重设/解绑/获焦
- `handleToggleFullscreen` 用 transitionend 替代 sleep
- 5 处补充注释解释行为变更

---

## 八、关键坑与注意事项（必读）

### 🟥 P0-1：owner 关系可能被 wry/Tauri 内部重置

**现象**：调用 `set_position` / `set_size` 后，wry 内部用 `SetWindowPos` 移动窗口，**可能带 z-order flag**，连带把 `GWLP_HWNDPARENT` 抹掉或让 owned window 离开 owner 上方。

**对策**：在 `resize_browser_webview` 末尾、关闭重开时、显式 `show_browser` 前都重设一次 owner（见 3.2.3 改动点 D）。`set_browser_as_owned` 设计为幂等，可放心反复调。

### 🟥 P0-2：WebView2 宿主窗口行为差异

**现象**：WebView2 内部用 Edge 渲染进程，对宿主窗口的 HWND 操作有限制。直接 `SetWindowLongPtrW` 改 WebView2 窗口的 parent 在某些 Edge 版本下可能导致：
- 鼠标/触摸事件路由到错误的窗口
- 输入法（IME）候选框位置错乱
- 页面内 `window.print()` 的预览窗口绑到错窗口

**对策**：**第一步只做"最小 POC"**——只加 3.2.2 + 3.2.3，去掉 `always_on_top`，跑 1-2 天验证打字、滚动、Ctrl+F、复制粘贴、IME 都正常，**再上完整改造**。

### 🟧 P1-1：剪藏弹窗恢复时主窗口未获焦

**现象**：owned window 跟随 owner 失焦自动隐藏，剪藏完成时只调 `show_browser` 可能被 owned 的"仍处于隐藏态"压住。

**对策**：在 `show_browser` 中先 `set_focus` 主窗口（见 3.2.3 改动点 F）。这是 v1 版完全没提到的关键顺序。

### 🟧 P1-2：Tauri/wry 可能在窗口事件回调里重置 parent

**现象**：Tauri 2.x 的 `WebviewWindowBuilder::on_window_event` 内部会调底层 Win32 API，可能覆盖 GWLP_HWNDPARENT。

**对策**：在 on_window_event 注册时显式调一次 set_browser_as_owned（3.2.3 改动点 B 已包含），并准备在 on_window_event 的 `Moved` / `Resized` 事件中再次重设（如果 POC 发现问题再加）。

### 🟨 P2-1：行为变更（其他窗口可盖住浏览器）

`always_on_top` 的本意是"无论用户在做什么，浏览器都要露出来"。改为 owner 关系后，**其他 app（聊天窗口、微信、终端）可以盖住浏览器**。

**这是设计取舍，不是 bug 修复**。处理：
- 在用户告知这次变更的 changelog 里明确说明
- 如需要"彻底 topmost" 模式，可加一个配置项（**本计划不实现**，留作未来扩展）

### 🟨 P2-2：多显示器

主窗口拖到第二个显示器后，owned window 的 z-order 基于**屏幕坐标**。如果浏览器坐标算错（logical → physical 转换），owned 关系还在但窗口位置错了。

**对策**：验证清单 §10 第 6 项多显示器拖拽测试。如有问题，在 `resize_browser_webview` 中加 `MonitorFromWindow` 校验。

### 🟨 P2-3：alt+Tab 行为变化

owned window 在 alt+Tab 列表里**可能不显示**（取决于 `WS_EX_TOOLWINDOW` 标志）。当前已有 `skip_taskbar(true)`，行为类似，用户可能无感。

**对策**：验证清单 §10 第 7 项 alt+Tab 测试。

### 🟨 P2-4：过渡时序用 `transitionend` 而非 `sleep`

`setTimeout(100)` 等待面板动画在低性能机器上不够。v1 版用 `sleep(100)` 不可靠。**统一改用 `transitionend` + 400ms 兜底**（见 3.3.5）。

### 🟨 P2-5：modal dialog 不触发 owner 隐藏

退出确认 dialog 是 modal 的，owned window **不会**自动消失。`tryExit` 中保留 `hide_browser`（见 3.3.3），但**取消退出时调 show_browser 恢复时**会自动走 3.2.3 改动点 F 的 set_focus 逻辑。

### 🟨 P2-6：raw-window-handle 版本对齐

Tauri 2.x 对 raw-window-handle 的版本要求严格（2.0 用 0.5，2.1+ 用 0.6）。**改之前 `cargo tree -i raw-window-handle` 查实际版本**，写入对应版本号。

---

## 九、回退方案

> 本改造已于 2026-07-06 完成（详见 §十一 实施步骤记录）。下方给出**改造已上线后**的三档回退路径，按"回退代价从小到大"排序。

### 9.1 软回退：保留 owner + 加回 `always_on_top`

**触发场景**：发现 §八 P0-2 类问题（WebView2 在某些 Edge 版本下 IME 错位、鼠标路由异常、print 预览绑错窗口），但**最小化跟随、Win+D、任务栏等基础 bug 修复要保留**。

**回退代价**：1 行 Rust 代码修改 + 重启应用。

**操作**：

打开 `src-tauri/src/commands.rs`，找到 `create_browser_webview` 中的 builder 链（当前第 2138 行附近）：

```rust
.resizable(true)
// ★ POC 阶段：暂时禁用 always_on_top，改用 owner 关系
// .always_on_top(true)            ← 取消这一行的注释
// 设置标准桌面浏览器 User-Agent，防止政企网站检测 WebView 并拒绝访问
```

将 `// .always_on_top(true)` 改为 `.always_on_top(true)` 即可。owner 关系**继续保留**——两个特性叠加，最小化跟随等基础修复不受影响，只是 z-order 又变回"永远在最上"（牺牲 P2-1 的"行为变更"，换取 P0-2 的稳健性）。

**副作用**：
- 其他程序窗口**不再能盖住**浏览器（回到 `always_on_top` 行为）
- 但 4 类窗口管理 bug（最小化、Win+D、任务栏、销毁跟随）依然修复

### 9.2 中回退：去掉 owner，只用 `always_on_top`（回到"半步状态"）

**触发场景**：9.1 仍有问题，需要**彻底放弃 owner 关系**，先稳定住线上。

**回退代价**：3 处代码修改（Rust）+ 1 处 Cargo.toml 依赖清理。

**操作**：

**步骤 1**：恢复 `always_on_top(true)`（同 9.1）。

**步骤 2**：注释掉 owner 设置代码块（`src-tauri/src/commands.rs` 第 2169-2177 行）：

```rust
// ★ POC：建立所属关系，浏览器窗口跟随主窗口
// #[cfg(target_os = "windows")]
// {
//     if let Some(main_win) = app.get_webview_window("main") {
//         if let Err(e) = set_browser_as_owned(&main_win, &wv) {
//             eprintln!("[Browser] 设置 owned window 失败: {}", e);
//         }
//     }
// }
```

**步骤 3**：恢复失焦监听（`src-tauri/src/commands.rs`，在 `set_browser_as_owned` 块下方插入）：

```rust
let app_handle2 = app.clone();
// 监听浏览器窗口失焦：浏览器失焦 + 主窗口也失焦 → 用户点到了程序外 → 隐藏浏览器
wv.on_window_event(move |event| {
    if let tauri::WindowEvent::Focused(false) = event {
        if let Some(main) = app_handle2.get_webview_window("main") {
            if let Ok(main_focused) = main.is_focused() {
                if !main_focused {
                    if let Some(wv) = app_handle2.get_webview_window("browser") {
                        let _ = wv.hide();
                    }
                }
            }
        }
    }
});
```

**步骤 4**：回滚前端 `EditorView.vue` 的简化：

恢复 `handleMinimize`（第 1051-1059 行）：

```typescript
async function handleMinimize() {
  // 最小化前先隐藏浏览器子窗口（always_on_top 窗口不会跟随隐藏）
  if (browserOpen.value) {
    try {
      await invoke("hide_browser");
    } catch { /* 忽略 */ }
  }
  await getCurrentWindow().minimize();
}
```

恢复 `onFocusChanged` 的失焦分支（当前第 1020-1026 行）：

```typescript
} else {
  // 主窗口失焦，仅判断"最小化 → 隐藏浏览器"
  // "用户点击程序外"由 Rust 端浏览器窗口的 Focused(false) 事件处理
  const minimized = await getCurrentWindow().isMinimized();
  if (minimized) {
    await invoke("hide_browser");
  }
}
```

**步骤 5**：可选清理 `Cargo.toml`（不清理也能编译，只是死代码）：

```toml
# 保留 [target.'cfg(target_os = "windows")'.dependencies] 段，
# 因为 close_browser / resize_browser_webview / show_browser 的 owner 重设/解绑/获焦
# 代码仍在（步骤 2 只注释了创建时的 owner 设置）。
# 如果想把 owner 相关代码全部从代码库移除，再执行 git revert。
```

**副作用**：
- 4 个 bug 全部回退（最小化、Win+D、任务栏、销毁跟随都失效）
- 但 Rust 端所有命令仍可调用，剪藏/双通道/书签全部正常

### 9.3 硬回退：git revert 整个改造

**触发场景**：9.1 / 9.2 都救不回来，需要完全恢复改造前的代码状态。

**回退代价**：`git revert <本改造的 commit>` + 解决可能的冲突。

**操作**：

```bash
# 查看本改造涉及的 commits
git log --oneline -20

# revert 最新一个改造 commit（假设是 abc1234）
git revert abc1234 --no-edit

# 如有冲突，手动解决：
# - src-tauri/Cargo.toml：删除 [target.'cfg(target_os = "windows")'.dependencies] 段
# - src-tauri/src/commands.rs：恢复 .always_on_top(true)、失焦监听、set_browser_as_owned 等
# - src/views/EditorView.vue：恢复 handleMinimize / onFocusChanged 旧逻辑

git add -A
git revert --continue
```

**或者**直接回滚到改造前的 commit（不推荐，会丢失其他改动）：

```bash
git checkout <改造前的 commit hash> -- src-tauri/Cargo.toml src-tauri/src/commands.rs src/views/EditorView.vue
```

### 9.4 回退决策树

```
发现线上问题
    │
    ├─ 问题只影响边缘场景（IME / print 预览）？
    │   └─ YES → 9.1 软回退（加回 always_on_top，保留 owner）
    │
    ├─ 问题影响主要功能（剪藏 / 全屏跟随）？
    │   └─ YES → 9.2 中回退（去掉 owner，恢复旧逻辑）
    │
    └─ 问题严重到无法运行？
        └─ YES → 9.3 硬回退（git revert）
```

### 9.5 实施记录

| 日期 | 阶段 | 内容 | 验证结果 |
|---|---|---|---|
| 2026-07-06 | POC | 加 Cargo 依赖 + set_browser_as_owned + 注释掉 always_on_top | ✅ 4 bug 修复，IME/鼠标路由正常 |
| 2026-07-06 | 加固 | 删失焦监听 + resize 重设 owner + close 解绑 + show 获焦 + 前端简化 | ✅ 剪藏/全屏/折叠/关闭全部正常 |

### 9.6 经验沉淀

- **comment 优于 delete**：POC 阶段用 `// .always_on_top(true)` 注释而非删除，最终帮了 9.1 一行回退
- **cfg 隔离平台代码**：`#[cfg(target_os = "windows")]` 让 macOS/Linux 编译完全不受影响，回退时也只需关注 Windows
- **幂等函数设计**：`set_browser_as_owned` 设计为幂等，多处调用无副作用，让"重设"成为低成本防御

---

## 十、验证清单（增强版）

### 基础功能
- [ ] 打开浏览器 → 网址正常加载
- [ ] 选中网页文字 → 右键"存入素材库" → 弹窗正常
- [ ] 选中网页文字 → 右键"添加到 AI 对话" → 跳转正常
- [ ] 折叠/展开左侧栏 → 浏览器窗口跟随变化，不遮挡折叠按钮
- [ ] 折叠/展开右侧栏 → 同上
- [ ] 点击"沉浸模式"（全屏）→ 浏览器窗口正确适配全屏尺寸
- [ ] 退出沉浸模式 → 浏览器窗口恢复正常尺寸，两个折叠按钮可点击
- [ ] 反复折叠/展开多次 → 不会出现全屏 bug
- [ ] 点击任务栏图标最小化 → 浏览器窗口跟随隐藏
- [ ] 点击任务栏图标恢复 → 浏览器窗口跟随恢复
- [ ] Win+D 最小化全部 → 浏览器窗口跟随隐藏
- [ ] 点击程序外（其他窗口）→ 浏览器**会被盖住**（行为变更，要确认接受）
- [ ] 关闭浏览器（点击 ✕）→ 正常释放
- [ ] 退出程序 → 两个窗口正常关闭，无残留

### 边界场景（POC 必测）
- [ ] **多显示器**：主窗口拖到第二屏幕 → 浏览器跟随、无错位
- [ ] **alt+Tab**：浏览器窗口在切换列表里的行为是否符合预期
- [ ] **IME**：在浏览器中输入中文，候选框位置正常
- [ ] **window.print()**：网页内 Ctrl+P 调起打印预览
- [ ] **页面内新窗口**：`target="_blank"` 链接的拦截仍有效
- [ ] **剪藏→取消**：取消剪藏弹窗，浏览器正确恢复显示
- [ ] **退出→取消**：取消退出确认，浏览器正确恢复显示
- [ ] **快速操作**：1 秒内连续折叠展开 5 次 → 不卡死
- [ ] **断网**：浏览器显示网络错误页时，剪藏功能仍可用

### 回归测试
- [ ] Tauri 启动后 5 秒内不打开浏览器，确认无后台异常
- [ ] 浏览器窗口句柄跨进程访问无 panic
- [ ] `cargo build --release` 无新增 warning

---

## 十一、实施步骤（推荐分两步）

### 第一步：POC 验证（1-2 天）

只做：
1. `Cargo.toml` 加依赖
2. `commands.rs` 加 `set_browser_as_owned` 函数
3. `create_browser_webview` 注释掉 `always_on_top`，加 owner 设置
4. **保留**所有 `hide_browser` / `show_browser` / 失焦监听逻辑（不删）
5. `EditorView.vue` 不动

跑 1-2 天，观察：
- 4 个 bug 是否真的修好
- 是否有 WebView2 IME / 鼠标路由问题
- 其他 app 盖住浏览器是否符合用户预期

### 第二步：清理与加固（2-3 天）

POC 验证通过后，再做：
1. 删除 `commands.rs` 的失焦监听（3.2.3 改动点 C）
2. `resize_browser_webview` / `close_browser` / `show_browser` 加 owner 重设/解绑/获焦（3.2.3 改动点 D/E/F）
3. `EditorView.vue` 简化 `handleMinimize` / `onFocusChanged`（3.3.1 / 3.3.2）
4. 加 transitionend 监听（3.3.4 / 3.3.5 / 3.3.6）
5. 跑完所有验证清单

---

## 十二、与 v1 版的差异总览

| 项目 | v1 版 | v2 版（本次修订） |
|---|---|---|
| owner 重设时机 | 只在创建时 | 创建 + resize 后 + show 前 |
| close_browser | 不动 | 显式解绑 owner |
| show_browser | 不动 | 先 set_focus 主窗口 |
| 过渡时序 | sleep(100) | transitionend + 400ms 兜底 |
| 行为变更提示 | 无 | §八 P2-1 + §九回退方案 |
| 多显示器 | 未提 | §八 P2-2 + 验证清单第 6 项 |
| IME 风险 | 未提 | §八 P0-2 + POC 步骤 |
| alt+Tab | 未提 | §八 P2-3 + 验证清单第 7 项 |
| raw-window-handle 版本 | 写死 0.6 | 强调先查 lock 文件 |
| 实施步骤 | 一次性 | 分两步（POC + 加固） |
| 净增行数 | +31 | +51（更全面） |
