#!/bin/bash
# ============================================================
# session-state.sh — Persist agent session state to /workspace
# so work can resume after container restarts or interruptions.
# Sourced by entrypoint.sh and launch-copilot.sh
# ============================================================

STATE_DIR="/workspace/.copilot-session"
STATE_FILE="$STATE_DIR/state.json"
COPILOT_HOME_DIR="$STATE_DIR/copilot-home"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[session]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# ── Persist Copilot's own session store across container restarts ──
# ~/.copilot holds session history, auth, config. By symlinking it
# to /workspace/.copilot-session/copilot-home (on the host), sessions
# survive container stop/start and /resume works correctly.
setup_copilot_home_persistence() {
    mkdir -p "$COPILOT_HOME_DIR"

    if [ -d /root/.copilot ] && [ ! -L /root/.copilot ]; then
        # First run: move any existing content into persistent dir then symlink
        cp -rn /root/.copilot/. "$COPILOT_HOME_DIR/" 2>/dev/null || true
        rm -rf /root/.copilot
    fi

    if [ ! -L /root/.copilot ]; then
        ln -s "$COPILOT_HOME_DIR" /root/.copilot
        ok "Copilot session store linked to $COPILOT_HOME_DIR"
    fi
}

# ── Save state ───────────────────────────────────────────────
save_session_state() {
    local task="$1"
    local status="${2:-in_progress}"   # in_progress | planned | complete
    local session_id="${3:-}"

    mkdir -p "$STATE_DIR"

    local git_sha
    git_sha=$(cd /workspace && git rev-parse HEAD 2>/dev/null || echo "none")

    local plan_file="none"
    [ -f /workspace/PLAN.md ] && plan_file="/workspace/PLAN.md"

    # Safely JSON-encode the task string via Python
    python3 - << PYEOF
import json, os
state = {}
# Preserve existing fields if state file already exists
try:
    with open("$STATE_FILE") as f:
        state = json.load(f)
except Exception:
    pass

state.update({
    "status":       "$status",
    "project_type": "$(cat /tmp/project_type 2>/dev/null || echo unknown)",
    "git_sha_start": state.get("git_sha_start", "$git_sha"),
    "plan_file":    "$plan_file",
    "last_checkpoint": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
})

# Only set task/started_at on first write
if "task" not in state:
    state["task"] = """$task"""
    state["started_at"] = "${AGENT_SESSION_START:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

if "$session_id":
    state["session_id"] = "$session_id"

with open("$STATE_FILE", "w") as f:
    json.dump(state, f, indent=2)
PYEOF
    ok "Session state saved (status=$status)"
}

# ── Load state into env vars ─────────────────────────────────
load_session_state() {
    [ -f "$STATE_FILE" ] || return 1
    python3 - << 'PYEOF'
import json, os
try:
    with open(os.environ.get("STATE_FILE", "/workspace/.copilot-session/state.json")) as f:
        d = json.load(f)
    for k, v in d.items():
        # Emit shell variable assignments (caller evals this)
        safe = str(v).replace("'", "'\\''")
        print(f"RESUME_{k.upper()}='{safe}'")
except Exception as e:
    print(f"# Failed to load state: {e}")
PYEOF
}

# ── Check if there is an incomplete session ──────────────────
is_session_incomplete() {
    [ -f "$STATE_FILE" ] || return 1
    local status
    status=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('status',''))" 2>/dev/null)
    [ "$status" = "in_progress" ]
}

# ── Check if a plan exists but work hasn't started ───────────
is_session_planned() {
    [ -f "$STATE_FILE" ] || return 1
    local status
    status=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('status',''))" 2>/dev/null)
    [ "$status" = "planned" ]
}

# ── Mark session complete ────────────────────────────────────
mark_session_complete() {
    [ -f "$STATE_FILE" ] || return 0
    python3 - << PYEOF
import json
with open("$STATE_FILE") as f:
    d = json.load(f)
d["status"] = "complete"
d["completed_at"] = "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
with open("$STATE_FILE", "w") as f:
    json.dump(d, f, indent=2)
PYEOF
    ok "Session marked complete"
}

# ── Update last checkpoint timestamp ────────────────────────
touch_checkpoint() {
    [ -f "$STATE_FILE" ] || return 0
    python3 - << PYEOF
import json
with open("$STATE_FILE") as f:
    d = json.load(f)
d["last_checkpoint"] = "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
with open("$STATE_FILE", "w") as f:
    json.dump(d, f, indent=2)
PYEOF
}

export STATE_DIR STATE_FILE COPILOT_HOME_DIR
