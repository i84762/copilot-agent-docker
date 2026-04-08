<#
.SYNOPSIS
    Start the Copilot Agent UI — as an Electron desktop app or in a browser.

.PARAMETER Mode
    Launch mode: 'electron' (default on Windows) or 'browser' (opens in your default browser).

.PARAMETER Port
    Port for the embedded Express server (default: 3000).

.PARAMETER NoBrowser
    Browser mode only: don't auto-open a browser tab.

.EXAMPLE
    .\start-ui.ps1                        # Electron app (default)
    .\start-ui.ps1 -Mode browser          # Browser at http://localhost:3000
    .\start-ui.ps1 -Mode browser -Port 8080
    .\start-ui.ps1 -Mode electron         # Explicit Electron
#>
param(
    [ValidateSet('electron','browser')]
    [string] $Mode      = 'electron',
    [int]    $Port      = 3000,
    [switch] $NoBrowser                   # browser mode only
)

$ErrorActionPreference = 'Stop'
$UiDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║      Copilot Agent UI Launcher         ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Mode     : $Mode" -ForegroundColor White

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

$env:UI_PORT = $Port
Push-Location $UiDir

# ── Launch ─────────────────────────────────────────────────────────────────────
if ($Mode -eq 'electron') {
    Write-Host ""
    Write-Host "  Launching Electron app..." -ForegroundColor Cyan
    Write-Host "  (Close the window or press Ctrl+C to stop)" -ForegroundColor DarkGray
    Write-Host ""
    try {
        npx electron .
    } finally {
        Pop-Location
    }
} else {
    $url = "http://localhost:$Port"
    Write-Host ""
    Write-Host "  URL       : $url" -ForegroundColor White
    Write-Host "  SSH tunnel: ssh -L ${Port}:localhost:${Port} user@remote-host" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
    Write-Host ""

    if (-not $NoBrowser) {
        Start-Job -ScriptBlock {
            param($u)
            Start-Sleep -Seconds 1.5
            Start-Process $u
        } -ArgumentList $url | Out-Null
    }

    try {
        node server.js
    } finally {
        Pop-Location
    }
}
