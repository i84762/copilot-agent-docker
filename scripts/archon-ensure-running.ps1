param(
    [int]$Port = 3000,
    [int]$DockerWaitSeconds = 90
)

$ErrorActionPreference = 'Stop'

function Test-PortListening {
    param([int]$ListenPort)
    return [bool](Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Test-DockerResponsive {
    docker version --format '{{json .}}' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunUiScript = Join-Path $ScriptDir 'archon-run-ui.ps1'
$LogDir = Join-Path $env:LOCALAPPDATA 'Archon\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'ensure-running.log'

function Write-Log {
    param([string]$Message)
    "[$(Get-Date -Format s)] $Message" | Add-Content -Path $LogFile
}

if (-not (Test-DockerResponsive)) {
    $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (Test-Path $desktop) {
        Write-Log 'Docker daemon not responsive; launching Docker Desktop'
        $runningDesktop = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $runningDesktop) {
            Start-Process -FilePath $desktop | Out-Null
        }
        $deadline = (Get-Date).AddSeconds($DockerWaitSeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            if (Test-DockerResponsive) {
                Write-Log 'Docker daemon is responsive'
                break
            }
        }
        if (-not (Test-DockerResponsive)) {
            Write-Log 'Docker daemon still not responsive after wait window'
        }
    } else {
        Write-Log 'Docker Desktop.exe not found; skipping Docker startup'
    }
}

if (-not (Test-PortListening -ListenPort $Port)) {
    Write-Log "UI server not listening on port $Port; launching background server"
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden',
            '-File', ('"{0}"' -f $RunUiScript),
            '-Port', $Port
        ) `
        -WindowStyle Hidden | Out-Null
} else {
    Write-Log "UI server already listening on port $Port"
}
