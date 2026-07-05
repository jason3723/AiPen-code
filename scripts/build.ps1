<#
.SYNOPSIS
    AiPen 构建 + 签名 + latest.json 更新 —— 一键脚本
.DESCRIPTION
    严格按照 BUILD_SOP.md 流程执行：
    1. 前提检查（环境、密钥、依赖、版本一致性）
    2. 清理 + 构建
    3. 构建后验证（产物 + 签名有效性）
    4. 更新 latest.json
.NOTES
    文件: scripts/build.ps1
    参考: BUILD_SOP.md
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

# 确保脚本在项目根目录执行
Set-Location $ProjectRoot

# ============================================================
# 阶段 1: 前提检查
# ============================================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  阶段 1/4: 前提检查" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1.1 工作目录
Write-Host "`n[1.1] 工作目录: $(Get-Location)"

# 1.2 工具链版本
Write-Host "[1.2] 工具链版本检查"
try {
    $nodeVer = node --version 2>&1
    $npmVer = npm --version 2>&1
    $rustcVer = rustc --version 2>&1
    $cargoVer = cargo --version 2>&1
    Write-Host "  Node:    $nodeVer"
    Write-Host "  npm:     $npmVer"
    Write-Host "  Rustc:   $rustcVer"
    Write-Host "  Cargo:   $cargoVer"
} catch {
    Write-Host "  ❌ 工具链缺失！请安装 Node.js + Rust" -ForegroundColor Red
    exit 1
}

# 1.3 密钥检查
Write-Host "`n[1.3] 签名密钥检查"
if (Test-Path "key.pem") {
    Write-Host "  ✅ key.pem 存在 — 构建产物将被签名" -ForegroundColor Green
    $SignAvailable = $true
} else {
    Write-Host "  ⚠️  key.pem 不存在 — 将尝试从加密备份解密..." -ForegroundColor Yellow
    if (Test-Path "key_decoded.pem") {
        Write-Host "    发现 key_decoded.pem (rsign 加密)"
        try {
            $null = Get-Command rsign -ErrorAction Stop
            Write-Host "    请在终端手动执行: rsign decrypt -p <密码> -o key.pem key_decoded.pem" -ForegroundColor Yellow
        } catch {
            Write-Host "    rsign 未安装，请先安装或手动解密 key.pem" -ForegroundColor Red
        }
    }
    if (Test-Path "key_minisign.pem") {
        Write-Host "    发现 key_minisign.pem (minisign 加密)"
    }
    Write-Host "  ❌ 签名将不可用。是否继续无签名构建？(Y/N)" -ForegroundColor Red
    $response = Read-Host
    if ($response -ne "Y" -and $response -ne "y") {
        exit 1
    }
    $SignAvailable = $false
}

# 1.4 依赖
Write-Host "`n[1.4] 依赖检查"
if (Test-Path "node_modules") {
    Write-Host "  node_modules 存在，跳过 npm ci"
} else {
    Write-Host "  正在 npm ci..."
    npm ci
}

# 1.5 版本一致性
Write-Host "`n[1.5] 版本一致性检查"
$pkgVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tauriConf = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
$tauriVersion = $tauriConf.version
$cargoMatch = Select-String -Path "src-tauri/Cargo.toml" -Pattern '^version\s*=\s*"(.+)"'
$cargoVersion = $cargoMatch.Matches[0].Groups[1].Value

Write-Host "  package.json:       $pkgVersion"
Write-Host "  tauri.conf.json:    $tauriVersion"
Write-Host "  Cargo.toml:         $cargoVersion"

if ($pkgVersion -eq $tauriVersion -and $tauriVersion -eq $cargoVersion) {
    Write-Host "  ✅ 版本号一致: v$pkgVersion" -ForegroundColor Green
    $Version = $pkgVersion
} else {
    Write-Host "  ❌ 版本号不一致！请先同步再构建" -ForegroundColor Red
    exit 1
}

# ============================================================
# 阶段 2: 构建
# ============================================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  阶段 2/4: 构建" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 2.1 清理旧前端产物
Write-Host "`n[2.1] 清理 dist/"
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
Write-Host "  ✅ 已清理"

# 2.2 执行构建
Write-Host "`n[2.2] 执行 npm run tauri build（可能需要几分钟）"
Write-Host "  这包含: vue-tsc → vite build → cargo build --release → NSIS 打包 → Minisign 签名`n"

try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run tauri build 退出码: $LASTEXITCODE"
    }
    Write-Host "`n✅ 构建完成" -ForegroundColor Green
} catch {
    Write-Host "`n❌ 构建失败！" -ForegroundColor Red
    Write-Host "  请查看上方错误信息，参考 BUILD_SOP.md 第 6 节处理常见错误" -ForegroundColor Yellow
    exit 1
}

# ============================================================
# 阶段 3: 构建后验证
# ============================================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  阶段 3/4: 构建后验证" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$NsisDir = "src-tauri/target/release/bundle/nsis"
$Exe = "$NsisDir/AiPen_${Version}_x64-setup.exe"
$Sig = "$NsisDir/AiPen_${Version}_x64-setup.exe.sig"

Write-Host "`n[3.1] 产物检查"
if (Test-Path $Exe) {
    $exeSize = [math]::Round((Get-Item $Exe).Length / 1MB, 2)
    Write-Host "  ✅ 安装包: $Exe ($exeSize MB)"
} else {
    Write-Host "  ❌ 安装包缺失: $Exe" -ForegroundColor Red
    exit 1
}

if ($SignAvailable) {
    Write-Host "`n[3.2] 签名验证"
    if (Test-Path $Sig) {
        $sigSize = (Get-Item $Sig).Length
        if ($sigSize -gt 0) {
            Write-Host "  ✅ 签名文件: $Sig ($sigSize bytes)" -ForegroundColor Green
        } else {
            Write-Host "  ❌ 签名文件为 0 字节！key.pem 可能无效" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "  ❌ 签名文件缺失: $Sig" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "`n[3.2] 签名验证: 跳过（无 key.pem）"
}

# ============================================================
# 阶段 4: 更新 latest.json
# ============================================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  阶段 4/4: 更新 latest.json" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if ($SignAvailable) {
    $Signature = Get-Content $Sig -Raw
} else {
    Write-Host "`n⚠️  无签名，latest.json 的 signature 字段将留空" -ForegroundColor Yellow
    Write-Host "  后续可手动从 .sig 文件填入签名"
    $Signature = ""
}

$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# 尝试从 CHANGELOG 提取当前版本日志
$Notes = ""
if (Test-Path "docs/CHANGELOG.md") {
    $changelog = Get-Content "docs/CHANGELOG.md" -Raw
    # 简单的版本日志提取（匹配 "## v3.0.2" 格式的标题块）
    $pattern = "## v$([regex]::Escape($Version))[\s\S]*?(?=## v\d|$)"
    $match = [regex]::Match($changelog, $pattern)
    if ($match.Success) {
        $Notes = $match.Value.Trim()
        Write-Host "  ✅ 从 CHANGELOG.md 提取到 v$Version 更新日志"
    } else {
        Write-Host "  ⚠️  未在 CHANGELOG.md 中找到 v$Version 的更新日志，notes 将留空" -ForegroundColor Yellow
    }
}

$LatestJson = [ordered]@{
    version = $Version
    notes = $Notes
    pub_date = $PubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $Signature
            url = "https://github.com/jason3723/AiPen/releases/latest/download/AiPen_${Version}_x64-setup.exe"
        }
    }
}

$jsonString = $LatestJson | ConvertTo-Json -Depth 4
# 修复 PowerShell ConvertTo-Json 的 Unicode 转义问题
$jsonString = [System.Text.RegularExpressions.Regex]::Unescape($jsonString)
$jsonString | Set-Content latest.json -Encoding UTF8

Write-Host "`n✅ latest.json 已更新为 v$Version" -ForegroundColor Green
Write-Host "  pub_date: $PubDate"

# ============================================================
# 完成
# ============================================================
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  🎉 构建 + 签名 + latest.json 全部完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

Write-Host "`n📦 产物位置: $NsisDir" -ForegroundColor Cyan
Get-ChildItem $NsisDir -Filter "*.exe" | ForEach-Object { Write-Host "  $($_.Name)" }
Get-ChildItem $NsisDir -Filter "*.sig" | ForEach-Object { Write-Host "  $($_.Name)" }

Write-Host "`n📋 下一步（手动操作）：" -ForegroundColor Yellow
Write-Host "  1. 检查 latest.json 中的 notes 字段，必要时手动填写更新日志"
Write-Host "  2. git commit + git tag v$Version + git push"
Write-Host "  3. 上传 .exe 和 .sig 到 GitHub Releases"
Write-Host "  4. 确保仓库根目录 latest.json 已同步推送"
Write-Host ""
