$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js。请先安装 Node.js 20 或更高版本。'
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCommand -and -not $corepackCommand) {
  throw '未找到 pnpm 或 Corepack。请安装带 Corepack 的 Node.js 20 或更高版本。'
}
if ($pnpmCommand) {
  $pnpmDirectory = Split-Path -Parent $pnpmCommand.Source
  if (($env:Path -split ';') -notcontains $pnpmDirectory) {
    $env:Path = $pnpmDirectory + ';' + $env:Path
  }
}

function Invoke-Pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $PnpmArguments)
  if ($pnpmCommand) { & $pnpmCommand.Source @PnpmArguments }
  else { & $corepackCommand.Source 'pnpm@11.7.0' @PnpmArguments }
}

Write-Host '正在检查项目依赖…'
Invoke-Pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'browser agent 将在独立默认浏览器中启动。请在打开的 Chrome 或 Edge 页面使用 Runtime。'
Invoke-Pnpm --dir apps/web dev --host 127.0.0.1 --open
exit $LASTEXITCODE
