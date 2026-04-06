# Copilot Agent Docker

A generic Docker container that runs **GitHub Copilot CLI in autopilot mode** on any local project.  
Drop it on a Windows folder, pass a task, and let the agent work autonomously.

---

## Quick Start (Windows PowerShell)

```powershell
# 1. Set your GitHub token (needs Copilot + repo scopes)
$env:GH_TOKEN = "ghp_your_token_here"

# 2. Run against any project folder
.\run-copilot.ps1 `
  -ProjectPath "D:\Code\my-flutter-app" `
  -Task "Add user authentication with Firebase, write unit tests, and open a PR"
```

The container will:
1. Detect the project type (Flutter, Java, Node, Python, .NET, Go, Rust, Ruby)
2. Download and cache the required SDK
3. Fetch your global Copilot instructions from GitHub (if configured)
4. Read the task and launch Copilot CLI in **autopilot mode**
5. Grant all permissions automatically (no confirmation prompts)

---

## Task Resolution (priority order)

| Method | How |
|--------|-----|
| `-Task "..."` flag | Inline string passed to the script |
| `-TaskFile path\to\file.md` | Path to a markdown task file |
| `TASK.md` / `GOALS.md` / `MISSION.md` in project root | Auto-discovered |
| `COPILOT_TASK` env var | Set before running |

---

## Global Instructions from GitHub

Host your `copilot-instructions.md` in a GitHub repo (see `sample-instructions/`):

```powershell
.\run-copilot.ps1 `
  -ProjectPath "D:\Code\my-app" `
  -Task "Refactor the payment module" `
  -InstructionsRepo "myuser/copilot-config"
```

The container fetches `copilot-instructions.md` from the `main` branch and merges
it with the current project task before starting the agent.

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `GH_TOKEN` | ✅ | GitHub PAT with **Copilot Requests** + repo scopes |
| `COPILOT_TASK` | (see task resolution) | Inline task |
| `COPILOT_TASK_FILE` | (see task resolution) | Container path to task file |
| `COPILOT_INSTRUCTIONS_REPO` | Optional | `owner/repo` of your global instructions |
| `COPILOT_INSTRUCTIONS_FILE` | Optional | File path in repo (default: `copilot-instructions.md`) |
| `COPILOT_INSTRUCTIONS_BRANCH` | Optional | Branch (default: `main`) |
| `GIT_USER_NAME` | Optional | Git commit author name |
| `GIT_USER_EMAIL` | Optional | Git commit author email |
| `FLUTTER_VERSION` | Optional | Flutter version to install (default: `3.24.5`) |
| `GO_VERSION` | Optional | Go version to install (default: `1.22.5`) |

---

## Supported Project Types (auto-detected)

| Indicator file | Detected as | SDK installed |
|----------------|-------------|---------------|
| `pubspec.yaml` | Flutter | Flutter + Dart LSP |
| `pom.xml` | Java / Maven | JDK 17 + Maven |
| `build.gradle` | Java / Gradle | JDK 17 |
| `package.json` | Node.js | Node + npm deps |
| `requirements.txt` / `pyproject.toml` | Python | Python deps + pylsp |
| `*.csproj` / `*.sln` | .NET | .NET SDK (LTS) |
| `go.mod` | Go | Go toolchain |
| `Cargo.toml` | Rust | Rust via rustup |
| `Gemfile` | Ruby | Ruby + bundler |

---

## SDK Cache

SDKs are stored in a named Docker volume (`copilot_sdk_cache`) so they are
**not re-downloaded** on subsequent runs.

---

## Rebuilding the Image

```powershell
.\run-copilot.ps1 -ProjectPath "D:\Code\my-app" -Task "..." -Rebuild
```

---

## Safety Rules (enforced via instructions)

- ❌ Never deletes the repository (`rm -rf /workspace` is forbidden)
- ✅ Commits frequently with descriptive messages
- ✅ Fixes errors automatically before asking for help
- ✅ Works until all tasks are complete

---

## File Structure

```
copilot-agent-docker/
├── Dockerfile                        # Container image definition
├── docker-compose.yml                # Compose config (volumes, env vars)
├── run-copilot.ps1                   # Windows PowerShell launcher
├── scripts/
│   ├── entrypoint.sh                 # Container startup logic
│   ├── detect-and-install.sh         # Project type detection + SDK install
│   └── launch-copilot.sh             # Copilot CLI launch via tmux
└── sample-instructions/
    └── copilot-instructions.md       # Template — upload to YOUR GitHub repo
```
