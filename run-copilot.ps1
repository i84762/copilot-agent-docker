<#
.SYNOPSIS
    Run an AI coding agent in a Docker container on any local project folder.

.DESCRIPTION
    Builds (once) and runs the copilot-agent container, mounting your
    project folder into /workspace. Supports multiple AI agents:
    GitHub Copilot CLI, Claude Code, Gemini CLI, and Aider.

.PARAMETER Agent
    Which AI agent to use: copilot (default), claude, gemini, aider
    Example: -Agent claude

.PARAMETER ProjectPath
    Full path to your project folder on Windows.
    Example: -ProjectPath "D:\Code\my-flutter-app"

.PARAMETER Task
    Inline task string. Overrides any TASK.md in the project.

.PARAMETER TaskFile
    Path to a task file (inside the project folder or absolute).

.PARAMETER GhToken
    GitHub PAT. Required for copilot; optional for others. Falls back to $env:GH_TOKEN.

.PARAMETER AnthropicApiKey
    Anthropic API key. Required for claude agent (and aider with Claude models).

.PARAMETER GeminiApiKey
    Google Gemini API key. Required for gemini agent (and aider with Gemini models).

.PARAMETER OpenAiApiKey
    OpenAI API key. Required for aider with OpenAI models.

.PARAMETER AiderModel
    Model for Aider (e.g. gpt-4o, claude-3-5-sonnet-20241022, gemini/gemini-1.5-pro).
    Auto-detected from available API keys if not set.

.PARAMETER InstructionsRepo
    GitHub repo containing your global instructions. Format: "owner/repo"

.PARAMETER Rebuild
    Force a Docker image rebuild.

.EXAMPLE
    .\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -Task "Fix all failing tests"

.EXAMPLE
    .\run-copilot.ps1 -Agent claude -ProjectPath "D:\Code\my-app" `
        -AnthropicApiKey "sk-ant-xxxx" -Task "Add unit tests"

.EXAMPLE
    .\run-copilot.ps1 -Agent aider -ProjectPath "D:\Code\my-app" `
        -OpenAiApiKey "sk-xxxx" -AiderModel "gpt-4o" -Task "Refactor auth module"
#>

param(
    [ValidateSet('copilot','claude','gemini','aider')]
    [string]$Agent       = "copilot",

    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [string]$Task        = "",
    [string]$TaskFile    = "",

    # Per-agent API keys
    [string]$GhToken           = $env:GH_TOKEN,
    [string]$AnthropicApiKey   = $env:ANTHROPIC_API_KEY,
    [string]$GeminiApiKey      = $env:GEMINI_API_KEY,
    [string]$OpenAiApiKey      = $env:OPENAI_API_KEY,
    [string]$AiderModel        = $env:AIDER_MODEL,

    [string]$InstructionsRepo  = $env:COPILOT_INSTRUCTIONS_REPO,
    [string]$InstructionsFile  = "copilot-instructions.md",
    [string]$InstructionsBranch = "main",
    [string]$GitUserName = $env:GIT_USER_NAME,
    [string]$GitUserEmail = $env:GIT_USER_EMAIL,
    [string]$FlutterVersion = "3.24.5",
    [string]$GoVersion      = "1.22.5",

    # Firebase Test Lab
    [string]$FirebaseProjectId     = $env:FIREBASE_PROJECT_ID,
    [string]$GcloudKeyFile         = $env:GCLOUD_KEY_FILE,
    [string]$GoogleCredentialsJson = $env:GOOGLE_CREDENTIALS_JSON,
    [string]$FirebaseTestDevice    = $env:FIREBASE_TEST_DEVICE,
    [string]$FirebaseTestTimeout   = $env:FIREBASE_TEST_TIMEOUT,

    # Mode flags
    [switch]$Plan,
    [switch]$Resume,
    [switch]$NewSession,
    [switch]$NoHostInstructions,

    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Validate ────────────────────────────────────────────────
if (-not (Test-Path $ProjectPath)) {
    Write-Error "ProjectPath does not exist: $ProjectPath"
    exit 1
}
if (-not $GhToken -and $Agent -eq "copilot") {
    Write-Error "GH_TOKEN not set. Pass -GhToken or set the env var (required for the copilot agent)."
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

# ── Host Copilot home (for global instructions) ─────────────
# Auto-detect %USERPROFILE%\.copilot; create it so Docker bind mount always works
$HostCopilotHome = Join-Path $env:USERPROFILE ".copilot"
if (-not (Test-Path $HostCopilotHome)) {
    New-Item -ItemType Directory -Path $HostCopilotHome -Force | Out-Null
}
$env:HOST_COPILOT_HOME = $HostCopilotHome
$env:COPILOT_USE_HOST_INSTRUCTIONS = if ($NoHostInstructions) { "false" } else { "true" }

# ── Compose env ──────────────────────────────────────────────
$env:AGENT                     = $Agent
$env:PROJECT_PATH              = $ProjectPath
$env:GH_TOKEN                  = $GhToken
$env:ANTHROPIC_API_KEY         = $AnthropicApiKey
$env:GEMINI_API_KEY            = $GeminiApiKey
$env:OPENAI_API_KEY            = $OpenAiApiKey
$env:AIDER_MODEL               = $AiderModel
$env:COPILOT_TASK              = $Task
$env:COPILOT_TASK_FILE         = $ContainerTaskFile
$env:COPILOT_INSTRUCTIONS_REPO = $InstructionsRepo
$env:COPILOT_INSTRUCTIONS_FILE = $InstructionsFile
$env:COPILOT_INSTRUCTIONS_BRANCH = $InstructionsBranch
$env:GIT_USER_NAME             = $GitUserName
$env:GIT_USER_EMAIL            = $GitUserEmail
$env:FLUTTER_VERSION           = $FlutterVersion
$env:GO_VERSION                = $GoVersion

# Mode flags
$env:COPILOT_PLAN_MODE         = if ($Plan)       { "true" } else { "false" }
$env:COPILOT_FORCE_RESUME      = if ($Resume)     { "true" } else { "false" }
$env:COPILOT_NEW_SESSION       = if ($NewSession) { "true" } else { "false" }

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
Write-Host "  Agent   : $Agent" -ForegroundColor White

# ── Show mode ─────────────────────────────────────────────────
if ($Plan) {
    Write-Host "  Mode    : PLAN — interactive, Copilot will ask clarifying questions" -ForegroundColor Yellow
} elseif ($NewSession) {
    Write-Host "  Mode    : NEW SESSION — all previous state will be cleared" -ForegroundColor Red
} elseif ($Resume) {
    Write-Host "  Mode    : RESUME — forcing resume of last session" -ForegroundColor Magenta
} else {
    # Auto-detect resume from state file
    $StateFile = Join-Path $ProjectPath ".copilot-session\state.json"
    if (Test-Path $StateFile) {
        $State = Get-Content $StateFile | ConvertFrom-Json
        if ($State.status -eq "in_progress") {
            Write-Host "  Mode    : AUTO-RESUME — incomplete session detected" -ForegroundColor Magenta
            Write-Host "  Checkpoint: $($State.last_checkpoint)" -ForegroundColor DarkGray
        } elseif ($State.status -eq "planned") {
            Write-Host "  Mode    : EXECUTE PLAN — PLAN.md found, running autonomously" -ForegroundColor Green
        } else {
            Write-Host "  Mode    : NORMAL — fresh autonomous run" -ForegroundColor Green
        }
    } else {
        Write-Host "  Mode    : NORMAL — fresh autonomous run" -ForegroundColor Green
    }
}

Write-Host "  Project : $ProjectPath" -ForegroundColor White
if ($Task)             { Write-Host "  Task    : $($Task.Substring(0, [Math]::Min(60,$Task.Length)))..." -ForegroundColor White }
if ($ContainerTaskFile){ Write-Host "  TaskFile: $ContainerTaskFile" -ForegroundColor White }
if ($InstructionsRepo) { Write-Host "  Config  : $InstructionsRepo" -ForegroundColor White }
$hostInstrFile = Join-Path $HostCopilotHome "copilot-instructions.md"
if (-not $NoHostInstructions -and (Test-Path $hostInstrFile)) {
    Write-Host "  HostInst: $hostInstrFile" -ForegroundColor White
} elseif (-not $NoHostInstructions) {
    Write-Host "  HostInst: (none — create $hostInstrFile to add global rules)" -ForegroundColor DarkGray
} else {
    Write-Host "  HostInst: disabled (-NoHostInstructions)" -ForegroundColor DarkGray
}
if ($FirebaseProjectId){ Write-Host "  Firebase: $FirebaseProjectId ($($env:FIREBASE_TEST_DEVICE))" -ForegroundColor Green }
else                   { Write-Host "  Firebase: disabled" -ForegroundColor DarkGray }
Write-Host "══════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""

# ── Run ──────────────────────────────────────────────────────
# --rm  : remove container on exit
# -it   : allocate pseudo-TTY for Copilot's TUI
docker compose -f "$ScriptDir\docker-compose.yml" run --rm copilot-agent
