# Copilot Agent Docker

Run **GitHub Copilot CLI autonomously** on any local project folder.  
Point it at your code, give it a task — it detects the project type, installs the right SDK, plans, executes, tests, and writes a full change report. No prompts, no babysitting.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker Desktop** | [Install](https://www.docker.com/products/docker-desktop/) — must be running |
| **PowerShell 7+** | [Install](https://aka.ms/powershell) — required on Windows |
| **GitHub PAT** | Token with **Copilot Requests** + **repo** scopes → [Create one](https://github.com/settings/personal-access-tokens/new) |

---

## Quick Start

```powershell
# 1. Set your GitHub token
$env:GH_TOKEN = "ghp_your_token_here"

# 2. Run against any project — task inline
.\run-copilot.ps1 `
  -ProjectPath "D:\Code\my-flutter-app" `
  -Task "Add Firebase authentication, write widget tests, open a PR"
```

Or place a `TASK.md` in your project root and omit `-Task` entirely:

```powershell
.\run-copilot.ps1 -ProjectPath "D:\Code\my-flutter-app"
```

---

## Providing a Task

The agent looks for its task in this order — **first match wins**:

| Priority | How | Example |
|----------|-----|---------|
| 1 | `-Task "..."` argument | `-Task "Fix all failing tests"` |
| 2 | `-TaskFile path\to\file.md` argument | `-TaskFile "D:\tasks\sprint.md"` |
| 3 | `TASK.md` in project root | auto-discovered |
| 4 | `GOALS.md` in project root | auto-discovered |
| 5 | `GOAL.md` / `MISSION.md` / `TODO.md` / `.copilot-task.md` | auto-discovered |
| 6 | Saved task from last interrupted session | auto-resumed |

You never need to pass `-Task` if one of the auto-discovered files exists.

---

## Supported Agents

The container supports four AI coding agents. Select one via `-Agent` flag or `AGENT` env var:

| Agent | `-Agent` value | Required Key | Notes |
|-------|---------------|-------------|-------|
| **GitHub Copilot CLI** | `copilot` *(default)* | `GH_TOKEN` | Requires GitHub Copilot subscription |
| **Claude Code** | `claude` | `ANTHROPIC_API_KEY` | Anthropic API key from console.anthropic.com |
| **Gemini CLI** | `gemini` | `GEMINI_API_KEY` | Google AI API key from aistudio.google.com |
| **Aider** | `aider` | One of the above | Auto-detects model from available keys |

```powershell
# GitHub Copilot (default)
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -Task "Add unit tests"

# Claude Code
.\run-copilot.ps1 -Agent claude -ProjectPath "D:\Code\my-app" `
    -AnthropicApiKey "sk-ant-..." -Task "Refactor auth module"

# Gemini CLI
.\run-copilot.ps1 -Agent gemini -ProjectPath "D:\Code\my-app" `
    -GeminiApiKey "AIza..." -Task "Fix all lint warnings"

# Aider with OpenAI
.\run-copilot.ps1 -Agent aider -ProjectPath "D:\Code\my-app" `
    -OpenAiApiKey "sk-..." -AiderModel "gpt-4o" -Task "Implement dark mode"

# Aider with Claude (auto-detects if ANTHROPIC_API_KEY is set)
.\run-copilot.ps1 -Agent aider -ProjectPath "D:\Code\my-app" `
    -AnthropicApiKey "sk-ant-..." -Task "Add i18n support"
```

---

## All Flags

```
.\run-copilot.ps1 [flags]
```

### Agent

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-Agent` | string | `copilot` | Which agent to run: `copilot`, `claude`, `gemini`, `aider` |
| `-GhToken` | string | `$env:GH_TOKEN` | GitHub PAT — required for `copilot`; optional for others |
| `-AnthropicApiKey` | string | `$env:ANTHROPIC_API_KEY` | Required for `claude`; used by `aider` with Claude models |
| `-GeminiApiKey` | string | `$env:GEMINI_API_KEY` | Required for `gemini`; used by `aider` with Gemini models |
| `-OpenAiApiKey` | string | `$env:OPENAI_API_KEY` | Used by `aider` with OpenAI models |
| `-AiderModel` | string | auto-detect | Aider model override (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`) |

### Required

| Flag | Type | Description |
|------|------|-------------|
| `-ProjectPath` | string | Full Windows path to your project folder |

### Task

| Flag | Type | Description |
|------|------|-------------|
| `-Task` | string | Inline task description |
| `-TaskFile` | string | Path to a markdown task file (Windows path) |

### Mode

| Flag | Type | Description |
|------|------|-------------|
| `-Plan` | switch | **Interactive planning session.** Copilot reads the code and task, asks clarifying questions, suggests improvements, then writes `PLAN.md`. Re-run without `-Plan` to execute. |
| `-Resume` | switch | **Force resume** the last session even if it was marked complete. |
| `-NewSession` | switch | **Wipe all saved state** and start completely fresh. Use when you want a clean slate on the same project. |
| `-Rebuild` | switch | Force a Docker image rebuild (needed after Dockerfile changes). |

### Global Instructions

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-InstructionsRepo` | string | — | `owner/repo` of your GitHub repo containing `copilot-instructions.md` |
| `-InstructionsFile` | string | `copilot-instructions.md` | File path inside that repo |
| `-InstructionsBranch` | string | `main` | Branch to read from |
| `-NoHostInstructions` | switch | — | Skip reading `~/.copilot/copilot-instructions.md` from your machine |

### Git Identity

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-GitUserName` | string | `Copilot Agent` | Git commit author name |
| `-GitUserEmail` | string | `copilot@example.com` | Git commit author email |

### Firebase Test Lab

| Flag | Type | Description |
|------|------|-------------|
| `-FirebaseProjectId` | string | Your Firebase / GCP project ID |
| `-GcloudKeyFile` | string | Windows path to service account JSON key file |
| `-GoogleCredentialsJson` | string | Full JSON key contents as a string (alternative to key file) |
| `-FirebaseTestDevice` | string | Device spec (default: `model=oriole,version=33,locale=en,orientation=portrait`) |
| `-FirebaseTestTimeout` | string | Per-test timeout (default: `5m`) |

### SDK Versions

| Flag | Type | Default |
|------|------|---------|
| `-FlutterVersion` | string | `3.24.5` |
| `-GoVersion` | string | `1.22.5` |

---

## Recommended Workflow

### First time on a project

```powershell
# Step 1 — Plan (interactive, ~5-10 min)
#   Copilot reads the codebase, asks you questions, writes PLAN.md
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -Plan -Task "Add user auth with JWT"

# Review / edit PLAN.md in your project folder, then:

# Step 2 — Execute (autonomous, no input needed)
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app"
```

### If the container is stopped mid-task

Just re-run the same command. The agent detects the interrupted session and resumes automatically:

```powershell
# Auto-resumes from .copilot-session/state.json
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app"
```

### Start completely fresh on the same project

```powershell
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -NewSession -Task "New task"
```

### Force resume of a completed session

```powershell
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -Resume
```

---

## Session State

The agent saves state to your project folder so work survives container restarts:

```
your-project/
└── .copilot-session/
    ├── state.json          ← task, status, last checkpoint, session ID
    ├── copilot-home/       ← persisted ~/.copilot (enables native /resume)
└── .copilot-reports/
    └── 2026-04-06_10-00-00/
        ├── SUMMARY.md      ← read this — what was done, commits, test results
        ├── CHANGES.diff    ← full unified diff of all code changes
        ├── COMMIT_LOG.txt  ← git log with file stats
        ├── FILES_CHANGED.txt
        ├── TEST_RESULTS.txt
        └── FIREBASE_RESULTS.txt
    └── latest/             ← symlink to most recent report
└── PLAN.md                 ← generated by --plan, executed on next run
```

> `.copilot-session/` and `.copilot-reports/` are in `.gitignore` and will not be committed.

**Session statuses:**

| Status | Meaning |
|--------|---------|
| `in_progress` | Container stopped mid-task — will auto-resume on next run |
| `planned` | `PLAN.md` written, ready to execute — next run starts autonomously |
| `complete` | All tasks done — next run starts a fresh session |

---

## Auto-Detected Project Types

The agent detects project type from files in your project root and installs the correct SDK automatically:

| Detected by | Project type | SDK installed | LSP |
|-------------|-------------|---------------|-----|
| `pubspec.yaml` | Flutter / Dart | Flutter SDK + precache | Dart LSP |
| `pom.xml` | Java / Maven | JDK 17 + Maven | — |
| `build.gradle*` | Java / Gradle | JDK 17 | — |
| `package.json` | Node.js | npm install | TypeScript LSP (if TS project) |
| `requirements.txt` / `pyproject.toml` | Python | pip install | pylsp |
| `*.csproj` / `*.sln` | .NET | .NET SDK LTS | — |
| `go.mod` | Go | Go toolchain | — |
| `Cargo.toml` | Rust | Rust via rustup | — |
| `Gemfile` | Ruby | Ruby + bundler | — |

SDKs are cached in a Docker named volume (`copilot_sdk_cache`) and are **not re-downloaded** on subsequent runs.

---

## Global Instructions from GitHub

Host your own `copilot-instructions.md` in a GitHub repo to define standing rules for the agent across all your projects:

```powershell
.\run-copilot.ps1 `
  -ProjectPath "D:\Code\my-app" `
  -InstructionsRepo "myuser/copilot-config"
```

A ready-to-use template is in `sample-instructions/copilot-instructions.md`.  
Copy it to your own repo and customise it — the agent will fetch it at startup.

---

## Global Instructions from Your Machine

The container **automatically mounts** `%USERPROFILE%\.copilot` (your Windows home `.copilot` folder) into the container at startup.

If `%USERPROFILE%\.copilot\copilot-instructions.md` exists it is loaded as global instructions — no flags needed:

```
C:\Users\YourName\.copilot\
└── copilot-instructions.md   ← always loaded automatically
```

**Priority / merge order:**

| Source | When loaded |
|--------|-------------|
| GitHub repo (`-InstructionsRepo`) | If env var set — fetched at startup |
| Host machine (`~/.copilot/`) | Always (unless `-NoHostInstructions`) |

If **both** sources exist they are merged: repo instructions come first, then host instructions are appended.

**To disable host instructions for one run:**

```powershell
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -NoHostInstructions
```

The banner shows which instructions file was found:

```
  HostInst: C:\Users\YourName\.copilot\copilot-instructions.md
```

The agent also reads instructions from these files **inside your project** (standard Copilot locations):

```
AGENTS.md
.github/copilot-instructions.md
.github/instructions/**/*.instructions.md
```

---

## Firebase Test Lab Setup

Firebase Test Lab lets the agent run integration tests on real Android devices without a local emulator.

### 1. Create a service account key

1. Open [Firebase Console](https://console.firebase.google.com) → your project → **Project Settings → Service Accounts**
2. Click **Generate new private key** → save as `firebase-sa-key.json`
3. Go to [IAM](https://console.cloud.google.com/iam-admin/iam) → grant the service account the **Firebase Test Lab Admin** role

### 2. Run with Firebase enabled

```powershell
.\run-copilot.ps1 `
  -ProjectPath "D:\Code\my-flutter-app" `
  -Task "Run all integration tests on device" `
  -FirebaseProjectId "my-app-12345" `
  -GcloudKeyFile "C:\keys\firebase-sa-key.json"
```

The agent will build the APK and run tests via `ftl-test android` automatically.  
List available devices: `gcloud firebase test android models list`

---

## Publishing the Image

The included GitHub Actions workflow (`.github/workflows/publish.yml`) builds and pushes the image to both **ghcr.io** and **Docker Hub** on every push to `main`.

### Required GitHub Secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token ([create one](https://hub.docker.com/settings/security)) |

> `GITHUB_TOKEN` is automatic — no setup needed for ghcr.io.

Once set, push to `main` and the image will be published to:
- `ghcr.io/YOUR_USERNAME/copilot-agent-docker:latest`
- `YOUR_USERNAME/copilot-agent:latest`

---

## Web UI

A full interface to configure, launch, and monitor the agent — available as a **native Electron desktop app** (Windows/Mac/Linux) or as a **browser app** accessible remotely over SSH.

### Prerequisites

- **Node.js 18+** — [Install](https://nodejs.org)

### Launch

```powershell
cd copilot-agent-docker\ui

# Electron desktop app (default on Windows)
.\start-ui.ps1

# Browser mode (Mac/Linux or for remote SSH access)
.\start-ui.ps1 -Mode browser

# Browser on a custom port
.\start-ui.ps1 -Mode browser -Port 8080
```

On **Mac/Linux**:
```bash
npm start              # Electron app
npm run start:browser  # Browser at http://localhost:3000
```

### Electron vs Browser

| | Electron (Desktop) | Browser |
|--|--|--|
| **Platform** | Windows, Mac, Linux | Any browser |
| **Native file picker** | ✅ Click 📁 to browse folders | ✗ Type paths manually |
| **Remote access** | ✗ Local only | ✅ SSH tunnel or direct URL |
| **No install** | ✗ Needs Node.js | ✅ Just open URL |
| **Best for** | Local daily use | Remote servers / teams |

### Features

| Feature | Description |
|---------|-------------|
| **Configuration form** | All agent parameters with auto-save to localStorage |
| **Container selector** | Dropdown of running copilot-agent containers; click to tail logs |
| **Plan mode terminal** | Interactive xterm.js terminal — talk to Copilot, it reads your code and asks questions |
| **Execute Plan** | After planning, one click runs the agent autonomously on the plan |
| **Live log streaming** | ANSI-coloured output from any running container |
| **Build image** | Build the Docker image from the UI with streamed progress |
| **Cancel / Abort** | Graceful stop (generates change report) or force kill |
| **Remote Docker host** | Connect to a remote Docker host via SSH or TCP |
| **Download logs** | Save full terminal output as a `.log` file |

### Remote access (SSH tunnel)

Run the UI in browser mode on a remote machine and access it locally:

```bash
# On your local machine
ssh -L 3000:localhost:3000 user@remote-host
# Then open: http://localhost:3000
```

Or connect the UI directly to a remote Docker socket:

1. Click **⚙ Remote** in the top-right of the UI
2. Select **SSH** or **TCP**
3. Enter host details and click **Connect**

### Build distributable installers

```powershell
cd copilot-agent-docker\ui
npm run build:win    # → dist/Copilot Agent Setup.exe
npm run build:mac    # → dist/Copilot Agent.dmg
npm run build:linux  # → dist/Copilot Agent.AppImage
```

### Interactive Plan mode flow

1. Fill in **Project Path** and **GitHub Token**
2. Enter your task (or leave blank to auto-read from `TASK.md`)
3. Click **🗺 Plan** — a container starts, the terminal becomes interactive
4. Copilot reads your code and task, then asks clarifying questions in the terminal
5. Reply in the terminal — Copilot refines the plan
6. When satisfied, click **▶ Execute Plan** — a new container runs the plan autonomously
7. Monitor progress in the live log view; a change report appears in `.copilot-reports/`

---

## File Structure

```
copilot-agent-docker/
├── Dockerfile                           # Container image
├── docker-compose.yml                   # Volume mounts + all env vars
├── run-copilot.ps1                      # Windows CLI launcher
├── .env.example                         # Copy to .env for direct compose usage
├── .gitignore
├── ui/                                  # UI (Electron app + browser fallback)
│   ├── server.js                        # Express + WebSocket backend
│   ├── package.json
│   ├── electron-builder.yml             # Installer build config
│   ├── start-ui.ps1                     # Launcher (-Mode electron|browser)
│   ├── electron/
│   │   ├── main.js                      # Electron main process
│   │   ├── preload.js                   # Context bridge (native dialogs)
│   │   └── build/                       # Icons for installers
│   └── public/
│       ├── index.html                   # Single-page app
│       ├── app.js                       # Frontend logic (xterm.js, WebSocket, Electron API)
│       └── style.css                    # Dark GitHub theme
├── scripts/
│   ├── entrypoint.sh                    # Startup: auth, SDK, mode routing
│   ├── detect-and-install.sh            # Project type detection + SDK install
│   ├── setup-firebase.sh                # gcloud auth + ftl-test helper
│   ├── session-state.sh                 # Save/load/resume session state
│   ├── plan-mode.sh                     # Interactive planning session
│   ├── resume-session.sh                # Build resume context from git + plan
│   ├── launch-copilot.sh                # Start Copilot CLI via tmux (autopilot)
│   └── generate-report.sh               # Write change report to /workspace
├── sample-instructions/
│   └── copilot-instructions.md          # Template — upload to your GitHub repo
└── .github/
    └── workflows/
        └── publish.yml                  # Auto-build + push to ghcr.io + Docker Hub
```

