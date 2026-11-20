param(
    [ValidateSet('install', 'uninstall')]
    [string]$Action = 'install',
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)
$ErrorActionPreference = 'Stop'
$destination = Join-Path $PluginsDirectory 'cache-display'

if ($Action -eq 'uninstall') {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
        Write-Host "Removed $destination / 已移除 $destination"
    } else {
        Write-Host "Not installed: $destination / 未安装"
    }
    exit 0
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\cache-display')).Path
if (-not (Test-Path -LiteralPath (Join-Path $source 'plugin.json'))) { throw "Missing $source\plugin.json" }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
& robocopy.exe $source $destination /MIR /XJ /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit code $LASTEXITCODE)" }
Write-Host "Installed/updated at $destination"
Write-Host "First install: enable 'Cache Display' in the Antigravity Plugins panel, then open it from the side pane."
Write-Host "首次安装：在 Antigravity 的 Plugins 面板启用 Cache Display，然后从侧边栏打开。"
exit 0
