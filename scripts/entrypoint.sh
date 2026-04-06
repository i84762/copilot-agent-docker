#!/bin/bash
# ============================================================
# entrypoint.sh — Main container startup script
# ============================================================
set -e

BOLD='\033[1m'; RED='\033[0;31m'; GREEN='\033[0;32m'
YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[copilot-agent]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Copilot Agent Docker Container         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Auth ─────────────────────────────────────────────────
export GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
[ -z "$GH_TOKEN" ] && err "GH_TOKEN or GITHUB_TOKEN must be set."
ok "GitHub token found"

# ── 2. Git config ───────────────────────────────────────────
git config --global credential.helper \
    '!f() { echo "username=x-token"; echo "password='"$GH_TOKEN"'"; }; f'
git config --global init.defaultBranch main
[ -n "$GIT_USER_NAME" ]  && git config --global user.name  "$GIT_USER_NAME"
[ -n "$GIT_USER_EMAIL" ] && git config --global user.email "$GIT_USER_EMAIL"
ok "Git configured"

# ── 3. Detect project type and install SDKs ─────────────────
source /usr/local/bin/detect-and-install.sh

# ── 4. Set up Firebase Test Lab (if credentials provided) ────
source /usr/local/bin/setup-firebase.sh

# ── 4. Fetch global Copilot instructions from GitHub ────────
mkdir -p /root/.copilot

if [ -n "$COPILOT_INSTRUCTIONS_REPO" ]; then
    log "Fetching global instructions from ${COPILOT_INSTRUCTIONS_REPO}..."
    INSTR_FILE="${COPILOT_INSTRUCTIONS_FILE:-copilot-instructions.md}"
    INSTR_BRANCH="${COPILOT_INSTRUCTIONS_BRANCH:-main}"
    INSTR_URL="https://raw.githubusercontent.com/${COPILOT_INSTRUCTIONS_REPO}/${INSTR_BRANCH}/${INSTR_FILE}"

    if curl -sf -H "Authorization: token $GH_TOKEN" \
            "$INSTR_URL" -o /root/.copilot/copilot-instructions.md 2>/dev/null; then
        ok "Global instructions loaded from ${INSTR_URL}"
    else
        warn "Could not fetch instructions from ${INSTR_URL}"
    fi
fi

# ── 5. Resolve task ─────────────────────────────────────────
TASK=""

if [ -n "$COPILOT_TASK_FILE" ] && [ -f "$COPILOT_TASK_FILE" ]; then
    TASK=$(cat "$COPILOT_TASK_FILE")
    ok "Task loaded from file: $COPILOT_TASK_FILE"
elif [ -n "$COPILOT_TASK" ]; then
    TASK="$COPILOT_TASK"
    ok "Task loaded from COPILOT_TASK env var"
else
    for candidate in TASK.md GOALS.md GOAL.md MISSION.md TODO.md .copilot-task.md; do
        if [ -f "/workspace/$candidate" ]; then
            TASK=$(cat "/workspace/$candidate")
            ok "Task loaded from /workspace/$candidate"
            break
        fi
    done
fi

[ -z "$TASK" ] && err "No task found. Set COPILOT_TASK, COPILOT_TASK_FILE, or create TASK.md in your project."

echo ""
log "Task:"
echo -e "${BOLD}${TASK}${NC}"
echo ""

# ── 6. Launch Copilot CLI ───────────────────────────────────
exec /usr/local/bin/launch-copilot.sh "$TASK"
