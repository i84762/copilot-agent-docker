<#
.SYNOPSIS
    Run the Copilot Agent Docker container on any local project folder.

.DESCRIPTION
    Builds (once) and runs the copilot-agent container, mounting your
    project folder into /workspace. Copilot CLI auto-detects the project
    type, installs the right SDK, fetches your global instructions, reads
    the task, and works autonomously in autopilot mode.

.PARAMETER ProjectPath
    Full path to your project folder on Windows.
    Example: -ProjectPath "D:\Code\my-flutter-app"

.PARAMETER Task
    Inline task string. Overrides any TASK.md in the project.
    Example: -Task "Implement user auth, add unit tests, and push a PR"

.PARAMETER TaskFile
    Path to a task file (inside the project folder or absolute).
    Example: -TaskFile "D:\Code\my-flutter-app\TASK.md"

.PARAMETER InstructionsRepo
    GitHub repo containing your global copilot-instructions.md.
    Format: "owner/repo"  Example: -InstructionsRepo "acme/my-copilot-config"

.PARAMETER GhToken
    GitHub PAT. Falls back to $env:GH_TOKEN if not provided.

.PARAMETER Rebuild
    Force a Docker image rebuild.

.EXAMPLE
    .\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -Task "Fix all failing tests"

.EXAMPLE
    .\run-copilot.ps1 -ProjectPath "D:\Code\my-flutter-app" `
        -InstructionsRepo "myuser/copilot-instructions" `
        -GhToken "ghp_xxxx"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [string]$Task        = "",
    [string]$TaskFile    = "",
    [string]$InstructionsRepo  = $env:COPILOT_INSTRUCTIONS_REPO,
    [string]$InstructionsFile  = "copilot-instructions.md",
    [string]$InstructionsBranch = "main",
    [string]$GhToken     = $env:GH_TOKEN,
    [string]$GitUserName = $env:GIT_USER_NAME,
    [string]$GitUserEmail = $env:GIT_USER_EMAIL,
    [string]$FlutterVersion = "3.24.5",
    [string]$GoVersion      = "1.22.5",

    # Firebase Test Lab
    [string]$FirebaseProjectId   = $env:FIREBASE_PROJECT_ID,
    [string]$GcloudKeyFile       = $env:GCLOUD_KEY_FILE,       # Windows path to SA key JSON
    [string]$GoogleCredentialsJson = $env:GOOGLE_CREDENTIALS_JSON, # inline JSON string
    [string]$FirebaseTestDevice  = $env:FIREBASE_TEST_DEVICE,
    [string]$FirebaseTestTimeout = $env:FIREBASE_TEST_TIMEOUT,

    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Validate ────────────────────────────────────────────────
if (-not (Test-Path $ProjectPath)) {
    Write-Error "ProjectPath does not exist: $ProjectPath"
    exit 1
}
if (-not $GhToken) {
    Write-Error "GH_TOKEN not set. Pass -GhToken or set the env var."
    exit 1
}

# Resolve absolute path (Docker needs it)
$ProjectPath = Resolve-Path $ProjectPath

# Convert TaskFile to container path if it's inside the project
$ContainerTaskFile = ""
if ($TaskFile) {
    if (Test-Path $TaskFile) {
        $TaskFile = Resolve-Path $TaskFile
        $rel = [System.IO.Path]::GetRelativePath($ProjectPath, $TaskFile) `
                   -replace '\\', '/'
        if (-not $rel.StartsWith("..")) {
            $ContainerTaskFile = "/workspace/$rel"
        } else {
            Write-Warning "TaskFile is outside ProjectPath; it won't be accessible in the container."
        }
    }
}

# ── Build image ──────────────────────────────────────────────
$ImageName = "copilot-agent:latest"

if ($Rebuild -or -not (docker image inspect $ImageName 2>$null)) {
    Write-Host "Building Docker image '$ImageName'..." -ForegroundColor Cyan
    docker build -t $ImageName $ScriptDir
    if ($LASTEXITCODE -ne 0) { Write-Error "Docker build failed."; exit 1 }
    Write-Host "Image built." -ForegroundColor Green
} else {
    Write-Host "Using existing image '$ImageName'. Use -Rebuild to force rebuild." -ForegroundColor DarkCyan
}

# ── Compose env ──────────────────────────────────────────────
$env:PROJECT_PATH              = $ProjectPath
$env:GH_TOKEN                  = $GhToken
$env:COPILOT_TASK              = $Task
$env:COPILOT_TASK_FILE         = $ContainerTaskFile
$env:COPILOT_INSTRUCTIONS_REPO = $InstructionsRepo
$env:COPILOT_INSTRUCTIONS_FILE = $InstructionsFile
$env:COPILOT_INSTRUCTIONS_BRANCH = $InstructionsBranch
$env:GIT_USER_NAME             = $GitUserName
$env:GIT_USER_EMAIL            = $GitUserEmail
$env:FLUTTER_VERSION           = $FlutterVersion
$env:GO_VERSION                = $GoVersion

# Firebase Test Lab
$env:FIREBASE_PROJECT_ID       = $FirebaseProjectId
$env:GOOGLE_CREDENTIALS_JSON   = $GoogleCredentialsJson
$env:FIREBASE_TEST_DEVICE      = if ($FirebaseTestDevice)  { $FirebaseTestDevice }  else { "model=oriole,version=33,locale=en,orientation=portrait" }
$env:FIREBASE_TEST_TIMEOUT     = if ($FirebaseTestTimeout) { $FirebaseTestTimeout } else { "5m" }

# Handle SA key file: resolve path and set for volume mount
$env:GCLOUD_KEY_FILE = ""
$env:GOOGLE_APPLICATION_CREDENTIALS = ""
if ($GcloudKeyFile -and (Test-Path $GcloudKeyFile)) {
    $env:GCLOUD_KEY_FILE = Resolve-Path $GcloudKeyFile
    $env:GOOGLE_APPLICATION_CREDENTIALS = "/keys/sa-key.json"
}

# ── Summary ──────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  Copilot Agent Container" -ForegroundColor Cyan
Write-Host "  Project : $ProjectPath" -ForegroundColor White
if ($Task)             { Write-Host "  Task    : $($Task.Substring(0, [Math]::Min(60,$Task.Length)))..." -ForegroundColor White }
if ($ContainerTaskFile){ Write-Host "  TaskFile: $ContainerTaskFile" -ForegroundColor White }
if ($InstructionsRepo) { Write-Host "  Config  : $InstructionsRepo" -ForegroundColor White }
if ($FirebaseProjectId){ Write-Host "  Firebase: $FirebaseProjectId ($($env:FIREBASE_TEST_DEVICE))" -ForegroundColor Green }
else                   { Write-Host "  Firebase: disabled (set -FirebaseProjectId to enable)" -ForegroundColor DarkGray }
Write-Host "══════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""

# ── Run ──────────────────────────────────────────────────────
# --rm  : remove container on exit
# -it   : allocate pseudo-TTY for Copilot's TUI
docker compose -f "$ScriptDir\docker-compose.yml" run --rm copilot-agent
