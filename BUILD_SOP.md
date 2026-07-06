# AiPen 构建 + 签名 + 发布标准操作手册 (SOP)

> **这是唯一的构建发布操作标准。AI Agent 执行任何构建/签名/发布任务时，必须严格按本文档执行，不得自行发挥或跳过任何步骤。**

---

## 0. 术语定义

| 术语 | 含义 |
|------|------|
| **构建** | 前端 vue-tsc + vite build → Tauri cargo build --release → NSIS 打包 → Minisign 签名 |
| **签名** | Tauri v2 通过环境变量 `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 对 .exe 签名，生成 .sig 文件 |
| **发布** | 更新 latest.json → 推送到 GitHub → 上传到 GitHub Releases |
| **版本号** | `package.json` / `tauri.conf.json` / `Cargo.toml` / `latest.json` 中的 version 字段 |

---

## 1. 前提检查（构建前必须验证）

### 1.1 环境检查

```powershell
# 必须在项目根目录执行
pwd  # 必须是 D:/Project/AiPen 或等价路径

# 工具链版本
node --version   # Node >= 18
npm --version    # npm >= 9
rustc --version  # Rust >= 1.80
cargo --version  # Cargo >= 1.80
```

### 1.2 密钥检查（签名必备）

签名需要两个条件同时满足：

**条件 A：`key.pem`（私钥文件）存在于项目根目录**

```powershell
# 检查 key.pem 是否存在且为明文（非加密文件）
Test-Path "key.pem"
# 如果文件存在但不确定是否为明文：Get-Content key.pem -Raw -Encoding UTF8 应能看到可读的 base64 文本
```

**如果 key.pem 不存在**，需要从加密备份解密还原：

```powershell
# 方式一：使用 Minisign 解密（需要密码）
minisign -x key_minisign.pem -o key.pem

# 方式二：使用 rsign 解密（需要密码）
rsign decrypt -p <密码> -o key.pem key_decoded.pem
```

**条件 B：`tauri.conf.json` 中 `bundle.createUpdaterArtifacts` 必须为 `true`**

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

> **Tauri v2 签名机制**：与 v1 不同，v2 不会自动发现项目根目录的 `key.pem`。构建时必须通过环境变量显式指定私钥路径和密码。无需额外命令。详见 2.2 节。**`createUpdaterArtifacts: true` 是 v2 的显式配置项，不加则 Tauri 完全不会尝试签名。**

**⚠️ 重要概念区分——文件加密 vs 密钥密码锁：**

| 场景 | 症状 | 对应操作 |
|------|------|----------|
| **文件级加密** | `key.pem` 文件不存在或内容为乱码 | 从 `key_minisign.pem` 或 `key_decoded.pem` 解密还原 |
| **密钥密码锁** | `key.pem` 存在且明文可读，但私钥本身有 passphrase | 构建时传入 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

**不要混淆二者**：如果 `key.pem` 已经是可读的 base64 明文，就不需要再跑 `minisign -x` 或 `rsign decrypt`——错误类型是密码锁，不是文件加密。

### 1.3 依赖完整性检查

```powershell
npm ci   # 确保 node_modules 与 package-lock.json 一致
```

### 1.4 版本一致性检查

构建前，以下 3 个文件中的版本号**必须一致**：

| 文件 | 字段 |
|------|------|
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `package.version` |

验证命令：

```powershell
$v1 = (Get-Content package.json | ConvertFrom-Json).version
$v2 = (Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json).version
$v3 = (Get-Content src-tauri/Cargo.toml | Select-String '^version\s*=\s*"(.+)"' | ForEach-Object { $_.Matches.Groups[1].Value })
Write-Host "package.json: $v1"
Write-Host "tauri.conf.json: $v2"
Write-Host "Cargo.toml: $v3"
if ($v1 -eq $v2 -and $v2 -eq $v3) { Write-Host "✅ 版本一致" } else { Write-Host "❌ 版本不一致！" }
```

### 1.5 Tauri 签名配置检查

构建前确认 `tauri.conf.json` 中签名相关配置完整：

```powershell
$conf = Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json

# 必须项 1：createUpdaterArtifacts 为 true
$artifacts = $conf.bundle.createUpdaterArtifacts
if ($artifacts -eq $true) { Write-Host "✅ createUpdaterArtifacts: true" } else { Write-Host "❌ createUpdaterArtifacts 不为 true，签名不会执行！" }

# 必须项 2：updater 插件配置了 pubkey
$pubkey = $conf.plugins.updater.pubkey
if ($pubkey) { Write-Host "✅ updater pubkey 已配置" } else { Write-Host "❌ updater pubkey 缺失！" }
```

---

## 2. 构建流程（标准命令，不得修改）

### 2.1 清理旧构建产物

```powershell
# 删除前端打包产物
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue

# 注意：不建议每次删除 target/ 因为 Rust 增量编译很慢
# 只在遇到神秘编译错误时才执行：
# Remove-Item -Recurse -Force src-tauri/target -ErrorAction SilentlyContinue
```

### 2.2 执行构建

```powershell
# Tauri v2 签名需要环境变量：私钥路径 + 私钥密码
$env:TAURI_SIGNING_PRIVATE_KEY="D:\Project\AiPen\key.pem"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<密钥密码>"

npm run tauri build
```

**这个命令会自动执行以下步骤（Tauri CLI 内置流程）：**

1. **`beforeBuildCommand`**：`npm run build`（即 `vue-tsc --noEmit && vite build`）
   - `vue-tsc --noEmit`：TypeScript 严格类型检查
   - `vite build`：Vite 打包前端资源到 `dist/` 目录
2. **Rust 编译**：`cargo build --release` 编译 Rust 后端
3. **NSIS 打包**：生成 Windows 安装包
4. **Minisign 签名**：Tauri CLI 使用 `TAURI_SIGNING_PRIVATE_KEY` 指定的私钥对 .exe 签名，生成 .sig 文件

> **签名成功标志**：构建日志末尾应出现 `Finished 2 updater signatures at:` 字样，否则签名未执行。

### 2.3 构建产物位置

构建产物在：`src-tauri/target/release/bundle/nsis/`

```
src-tauri/target/release/bundle/nsis/
├── AiPen_3.0.X_x64-setup.exe         # 安装包
├── AiPen_3.0.X_x64-setup.exe.sig     # 签名文件
└── AiPen_3.0.X_x64_en-US.msi         # MSI 安装包（可选）
```

---

## 3. 构建后验证（必须执行）

### 3.1 产物存在性

```powershell
$version = (Get-Content package.json | ConvertFrom-Json).version
$nsisDir = "src-tauri/target/release/bundle/nsis"
$exe = "$nsisDir/AiPen_${version}_x64-setup.exe"
$sig = "$nsisDir/AiPen_${version}_x64-setup.exe.sig"

if (Test-Path $exe) { Write-Host "✅ 安装包存在" } else { Write-Host "❌ 安装包缺失！" }
if (Test-Path $sig) { Write-Host "✅ 签名文件存在" } else { Write-Host "❌ 签名文件缺失！" }
```

### 3.2 签名文件有效性

```powershell
# .sig 文件必须非空（> 0 字节）
$sigSize = (Get-Item $sig).Length
if ($sigSize -gt 0) { Write-Host "✅ 签名文件有效 ($sigSize bytes)" } else { Write-Host "❌ 签名文件为 0 字节！" }
```

**额外检查：文件时间戳对比**——确认 `.sig` 是本次构建生成的，而非残留的旧文件：

```powershell
$exeTime = (Get-Item $exe).LastWriteTime
$sigTime = (Get-Item $sig).LastWriteTime
Write-Host "exe: $exeTime"
Write-Host "sig: $sigTime"
if ($sigTime -ge $exeTime.AddMinutes(-1)) { Write-Host "✅ sig 是本次构建生成的" } else { Write-Host "❌ sig 是旧文件，Tauri 可能未尝试签名！" }
```

> **时间戳是诊断关键**：如果 `.sig` 修改时间远早于 `.exe`，说明 Tauri 根本没尝试签名——排查方向是配置问题（`createUpdaterArtifacts`、环境变量），而不是密钥问题。

---

## 4. 更新 latest.json（发布前必须执行）

### 4.1 规则

- `latest.json` 中的 `version` 必须等于 `package.json` 中的 `version`
- `signature` 字段的值来自 `.sig` 文件的内容
- `url` 格式：`https://github.com/jason3723/AiPen/releases/latest/download/AiPen_<版本>_x64-setup.exe`
- `notes`：从 `docs/CHANGELOG.md` 中提取当前版本的更新日志
- `pub_date`：当前 UTC 时间，格式 `YYYY-MM-DDTHH:mm:ssZ`

### 4.2 生成 latest.json

```powershell
$version = (Get-Content package.json | ConvertFrom-Json).version
$sigPath = "src-tauri/target/release/bundle/nsis/AiPen_${version}_x64-setup.exe.sig"
$signature = Get-Content $sigPath -Raw
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# 从 CHANGELOG 提取当前版本日志
$changelog = Get-Content docs/CHANGELOG.md -Raw
# 手动编辑 notes 字段，或从 CHANGELOG 提取

$latestJson = @{
    version = $version
    notes = ""
    pub_date = $pubDate
    platforms = @{
        "windows-x86_64" = @{
            signature = $signature
            url = "https://github.com/jason3723/AiPen/releases/latest/download/AiPen_${version}_x64-setup.exe"
        }
    }
}

$latestJson | ConvertTo-Json -Depth 4 | Set-Content latest.json -Encoding UTF8
Write-Host "✅ latest.json 已更新为 v$version"
```

**注意**：`notes` 字段需要手动填写（从 CHANGELOG 中复制当前版本的更新日志）。

---

## 4.5 更新 CHANGELOG.md（发布前必须执行）

### 4.5.1 规则

- 在每个版本的发布前，**必须**在 `docs/CHANGELOG.md` 顶部添加当前版本的更新日志条目
- 格式：`## v<version> (YYYY-MM-DD)` → 按类别（🏗️ 架构 / ✨ 新增 / 🔧 优化 / 🐛 修复 / 📝 变更）列出改动 → `---` 分隔线
- 分类参考：

| 前缀 | 含义 | 示例 |
|---|---|---|
| `🏗️ 架构重构` | 底层架构级改动 | 引擎切换、存储格式升级、窗口管理重构 |
| `✨ 新增` | 面向用户的新功能 | 新面板、新按钮、新流程 |
| `🔧 优化` | 已有功能的改进 | 性能、UI 微调、体验优化 |
| `🐛 修复` | Bug 修复 | 崩溃、逻辑错误、视觉异常 |
| `📝 变更` | 行为变更、依赖升级、已知限制 | 与旧版行为不同、非修复类调整 |

### 4.5.2 操作

```powershell
# 1. 打开 CHANGELOG
code docs/CHANGELOG.md

# 2. 在文件顶部「# AiPen 更新日志」与第一个「## vx.x.x」之间插入新版本条目
# 3. 按上面的格式填写当前版本的改动
# 4. git diff -- docs/CHANGELOG.md 确认无误
```

> **注意**：版本间的 `---` 分隔线不要遗漏，否则 markdown 渲染时版本标题会连在一起。

### 4.5.3 验证

```powershell
# 确认新版本条目在文件最顶部
Get-Content docs/CHANGELOG.md | Select-Object -First 5
```

---

## 5. 发布到 GitHub（手动步骤）

### 5.1 创建 Git Tag 并推送

```powershell
$version = (Get-Content package.json | ConvertFrom-Json).version

# 发布相关文件：CHANGELOG、latest.json、tauri 配置
git add docs/CHANGELOG.md latest.json src-tauri/tauri.conf.json
git commit -m "release: v$version"
git tag "v$version"
git push origin master
git push origin "v$version"
```

### 5.2 上传到 GitHub Releases

1. 打开 `https://github.com/jason3723/AiPen/releases/new?tag=v<VERSION>`
2. Release title：`v<VERSION>`
3. 描述：粘贴 `docs/CHANGELOG.md` 中当前版本的更新日志
4. 上传 3 个文件作为 Release Asset：
   - `src-tauri/target/release/bundle/nsis/AiPen_<VERSION>_x64-setup.exe`
   - `src-tauri/target/release/bundle/nsis/AiPen_<VERSION>_x64-setup.exe.sig`
   - `latest.json`
5. **双端点说明**：`latest.json` 同时存在于：
   - **Release Asset**（主端点，GitHub CDN 加速）：`https://github.com/jason3723/AiPen/releases/latest/download/latest.json`
   - **Repo 根目录**（备端点，git push）：已通过步骤 5.1 推送，客户端自动 fallback

---

## 6. 常见构建错误 & 固定处理方式

### 6.1 TypeScript 类型错误 (vue-tsc 失败)

**症状**：`npm run tauri build` 在 `beforeBuildCommand` 阶段失败，输出 TS 类型错误。

**处理**：
1. 查看错误输出，定位文件和行号
2. **修复源代码**——严禁使用 `// @ts-ignore` 或 `// @ts-expect-error`
3. 常见问题：缺少 import、类型不匹配、可选链使用不当
4. 修复后重新运行 `npm run tauri build`

### 6.2 Rust 编译错误

**症状**：`cargo build --release` 阶段失败。

**处理**：
1. 运行 `cd src-tauri && cargo check 2>&1` 查看完整错误
2. 根据编译器错误信息修复 Rust 源码
3. 常见问题：未使用的 import、类型不匹配、缺少 trait 实现

### 6.3 签名文件问题（三场景诊断法）

> **第一原则：对比 `.exe` 和 `.sig` 的文件修改时间**。时间戳告诉你 Tauri 是否尝试过签名，这决定了排查方向。

#### 场景 A：`.sig` 文件完全不存在

**症状**：构建日志中没有 `Finished 2 updater signatures at:`，`.sig` 文件根本未生成。

**根因**：Tauri v2 需要显式配置 `bundle.createUpdaterArtifacts: true`，否则完全跳过签名步骤。

**处理**：
1. 检查 `tauri.conf.json` → `bundle` → `createUpdaterArtifacts` 是否为 `true`
2. 添加配置后重新构建（参考 1.2 节条件 B）

#### 场景 B：`.sig` 存在但为 0 字节，且修改时间远早于 `.exe`

**症状**：`.sig` = 0 字节，`(Get-Item $sig).LastWriteTime` 是数小时/数天前的旧时间戳。

**根因**：这是之前某次构建留下的残留文件。本次构建**根本没尝试签名**。不要怀疑 key.pem 损坏。

**处理**：
1. 先用场景 A 的排查方法检查 `createUpdaterArtifacts`
2. 同时确认构建命令是否设置了 `TAURI_SIGNING_PRIVATE_KEY` 环境变量
3. 修复后重新构建

#### 场景 C：`.sig` 存在但为 0 字节，且修改时间与 `.exe` 一致

**症状**：Tauri 尝试了签名但失败，报错信息可能包含 `failed to decode secret key` 或 `Wrong password`。

**根因**：密钥的 passphrase（密码锁）未正确传入。

**处理**：
1. 确认 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量设置为正确密码
2. 重新构建

> **关键区分**：场景 B 是 Tauri 没尝试签名 → 排查配置。场景 C 是 Tauri 尝试了但失败 → 排查密码。**不要用场景 C 的错误信息（如 Wrong password）去跑场景 B 的文件解密操作（如 minisign -x）**——key.pem 是明文就不需要解密。

### 6.4 latest.json 签名验证失败

**症状**：客户端更新时提示签名验证失败。

**根因**：`latest.json` 中的 `signature` 字段与 `.sig` 文件内容不匹配，或公钥不匹配。

**处理**：
1. 确认使用了正确的 `key.pem`（与 `tauri.conf.json` 中的 `pubkey` 配对）
2. 确认 `latest.json` 中的 `signature` 是从 `.sig` 文件中完整复制的内容

### 6.5 版本号不一致

**症状**：构建产物版本号与预期不符。

**处理**：
1. 执行 1.4 节版本一致性检查
2. 同步 `package.json`、`tauri.conf.json`、`Cargo.toml` 中的版本号
3. 重新构建

---

## 7. AI Agent 执行纪律

当用户请求"构建"、"打包"、"签名"、"发布"、"发版"时，AI Agent 必须：

1. **先读取本 SOP**，确认理解所有步骤
2. **执行前提检查**（1.1 - 1.4），任何失败必须先修复再继续
3. **同步 CHANGELOG.md**（4.5）：在构建完成后，在 `docs/CHANGELOG.md` 顶部添加当前版本更新日志
4. **严格按顺序执行**：检查 → 版本号同步 → 构建 → 验证 → 更新 latest.json → 更新 CHANGELOG
5. **每步验证结果**：不要假设上一步成功，必须检查产物
6. **签名验证三要素**：产物存在（文件）→ 字节有效（>0）→ 时间戳一致（sig 由本次构建生成）
7. **遇到错误先查第 6 节**：按固定处理方式操作，不要自行发挥
8. **对比时间戳再排查**：`.sig` 修改时间远早于 `.exe` → 配置问题；时间一致 → 密码问题。**不要混淆文件加密与密钥密码锁**
9. **不要跳过签名验证**：`.sig` 文件必须非空
10. **发布前的 Git 操作必须用户确认**：不自动执行 `git push`
