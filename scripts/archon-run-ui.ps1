param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

function Test-PortListening {
    param([int]$ListenPort)
    return [bool](Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

if (Test-PortListening -ListenPort $Port) {
    exit 0
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$UiDir     = Join-Path $RepoRoot 'ui'

$LogDir = Join-Path $env:LOCALAPPDATA 'Archon\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'ui-server.log'

Set-Location $UiDir

"[$(Get-Date -Format s)] starting Archon UI server" | Add-Content -Path $LogFile
npm run start:browser *>> $LogFile
