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

AGENT="${AGENT:-copilot}"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Copilot Agent Docker Container         ║${NC}"
echo -e "${BOLD}║       Agent: ${AGENT}${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Auth ─────────────────────────────────────────────────
export GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"

# GH_TOKEN required for copilot; optional for others (needed for git push + instructions fetch)
if [ "$AGENT" = "copilot" ] && [ -z "$GH_TOKEN" ]; then
    err "GH_TOKEN or GITHUB_TOKEN must be set for the copilot agent."
fi
[ -n "$GH_TOKEN" ] && ok "GitHub token found" || warn "No GH_TOKEN — git push and private repo access will not work"

# ── 2. Git config ───────────────────────────────────────────
git config --global credential.helper \
    '!f() { echo "username=x-token"; echo "password='"$GH_TOKEN"'"; }; f'
git config --global init.defaultBranch main
[ -n "$GIT_USER_NAME" ]  && git config --global user.name  "$GIT_USER_NAME"
[ -n "$GIT_USER_EMAIL" ] && git config --global user.email "$GIT_USER_EMAIL"
ok "Git configured"

# ── 3. Session state + Copilot home persistence ─────────────
source /usr/local/bin/session-state.sh
setup_copilot_home_persistence

# NEW SESSION: wipe all saved state before doing anything else
if [ "${COPILOT_NEW_SESSION:-false}" = "true" ]; then
    warn "NEW SESSION requested — clearing all saved state..."
    rm -f "$STATE_FILE"
    rm -rf "$COPILOT_HOME_DIR/sessions" 2>/dev/null || true
    ok "State cleared — starting fresh"
fi

# ── 4. Detect project type and install SDKs ─────────────────
source /usr/local/bin/detect-and-install.sh

# ── 5. Firebase Test Lab setup ───────────────────────────────
source /usr/local/bin/setup-firebase.sh

# ── 6. Fetch global Copilot instructions from GitHub ────────
# (setup_copilot_home_persistence already linked ~/.copilot → persistent dir)
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

# ── 6b. Load global instructions from host ~/.copilot ───────
if [ "${COPILOT_USE_HOST_INSTRUCTIONS:-true}" != "false" ]; then
    HOST_INSTR=""
    for candidate in copilot-instructions.md instructions.md; do
        if [ -f "/host-copilot-home/$candidate" ]; then
            HOST_INSTR="/host-copilot-home/$candidate"
            break
        fi
    done

    if [ -n "$HOST_INSTR" ]; then
        mkdir -p /root/.copilot
        if [ -f /root/.copilot/copilot-instructions.md ]; then
            # Append host instructions after any repo-fetched instructions
            printf '\n\n<!-- Host global instructions from %s/.copilot/%s -->\n' \
                "$(hostname)" "$(basename "$HOST_INSTR")" \
                >> /root/.copilot/copilot-instructions.md
            cat "$HOST_INSTR" >> /root/.copilot/copilot-instructions.md
            ok "Host instructions merged into copilot-instructions.md"
        else
            cp "$HOST_INSTR" /root/.copilot/copilot-instructions.md
            ok "Host instructions loaded from ~/.copilot/$(basename "$HOST_INSTR")"
        fi
    else
        log "No host instructions found in /host-copilot-home (this is fine)"
    fi
fi

# ── 7. Resolve task ─────────────────────────────────────────
# Order: COPILOT_TASK_FILE > COPILOT_TASK env > auto-discovered files
# > resume from saved state
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

# Fall back to saved session task if resuming and no new task given
if [ -z "$TASK" ] && is_session_incomplete; then
    eval "$(load_session_state)"
    TASK="$RESUME_TASK"
    warn "No new task provided — using task from interrupted session"
fi

[ -z "$TASK" ] && err "No task found. Set COPILOT_TASK, COPILOT_TASK_FILE, or create TASK.md in your project."

echo ""
log "Task:"
echo -e "${BOLD}${TASK}${NC}"
echo ""

# ── 8. SIGTERM handler — save state + report on docker stop ─
export AGENT_SESSION_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cleanup() {
    echo ""
    warn "Container interrupted — saving checkpoint..."
    touch_checkpoint
    generate-report 2>/dev/null || true
    warn "State saved. Re-run the container to resume."
}
trap cleanup SIGTERM SIGINT

# ── 9. Decide mode ───────────────────────────────────────────

# PLAN MODE — interactive session to clarify requirements
if [ "${COPILOT_PLAN_MODE:-false}" = "true" ]; then
    log "Starting in PLAN mode..."
    source /usr/local/bin/plan-mode.sh "$TASK"
    exit 0
fi

# RESUME MODE — incomplete session detected (or forced via env)
if [ "${COPILOT_FORCE_RESUME:-false}" = "true" ] || is_session_incomplete; then
    log "Incomplete session detected — resuming..."
    source /usr/local/bin/resume-session.sh
    exec /usr/local/bin/launch-agent.sh "$TASK" "resume"
fi

# EXECUTE PLANNED WORK — a plan exists, jump straight into autopilot
if is_session_planned && [ -f /workspace/PLAN.md ]; then
    log "Plan found — executing autonomously..."
    exec /usr/local/bin/launch-agent.sh "$TASK" "planned"
fi

# NORMAL MODE — fresh autonomous run
exec /usr/local/bin/launch-agent.sh "$TASK" "normal"

