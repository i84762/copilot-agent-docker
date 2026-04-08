<#
.SYNOPSIS
    Start the Copilot Agent web UI.

.PARAMETER Port
    Port to listen on (default: 3000)

.PARAMETER NoBrowser
    Don't auto-open the browser.

.EXAMPLE
    .\start-ui.ps1
    .\start-ui.ps1 -Port 8080
    .\start-ui.ps1 -NoBrowser
#>
param(
    [int]   $Port      = 3000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$UiDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║      Copilot Agent UI Launcher         ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Node.js check ──────────────────────────────────────────────────────────────
try {
    $nodeVersion = (node --version 2>&1).ToString().TrimStart('v')
    $major = [int]($nodeVersion -split '\.')[0]
    if ($major -lt 18) {
        Write-Error "Node.js 18+ required. Current: v$nodeVersion`nDownload: https://nodejs.org"
        exit 1
    }
    Write-Host "  Node.js  : v$nodeVersion ✓" -ForegroundColor Green
} catch {
    Write-Error "Node.js not found. Install from https://nodejs.org (v18+)"
    exit 1
}

# ── Docker check ───────────────────────────────────────────────────────────────
try {
    docker info 2>&1 | Out-Null
    Write-Host "  Docker   : running ✓" -ForegroundColor Green
} catch {
    Write-Warning "Docker does not appear to be running. Start Docker Desktop first."
}

# ── Install dependencies ───────────────────────────────────────────────────────
$nodeModules = Join-Path $UiDir "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "`n  Installing npm dependencies..." -ForegroundColor Cyan
    Push-Location $UiDir
    npm install --loglevel=error
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed."; exit 1 }
    Pop-Location
    Write-Host "  Dependencies installed ✓" -ForegroundColor Green
}

# ── Start server ───────────────────────────────────────────────────────────────
$url = "http://localhost:$Port"
Write-Host ""
Write-Host "  URL      : $url" -ForegroundColor White
Write-Host "  SSH tunnel: ssh -L ${Port}:localhost:${Port} user@remote-host" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$env:UI_PORT = $Port

if (-not $NoBrowser) {
    # Open browser after a short delay (let server start first)
    Start-Job -ScriptBlock {
        param($u)
        Start-Sleep -Seconds 1.5
        Start-Process $u
    } -ArgumentList $url | Out-Null
}

Push-Location $UiDir
try {
    node server.js
} finally {
    Pop-Location
}
