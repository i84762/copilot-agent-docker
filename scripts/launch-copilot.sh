#!/bin/bash
# ============================================================
# launch-copilot.sh — Start Copilot CLI in autopilot mode via tmux
# Usage: launch-copilot.sh "<task>" [normal|resume|planned]
# ============================================================

TASK="$1"
MODE="${2:-normal}"   # normal | resume | planned
PROJECT_TYPE=$(cat /tmp/project_type 2>/dev/null || echo "unknown")

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[launch]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

source /usr/local/bin/session-state.sh

# ── Save initial state ───────────────────────────────────────
save_session_state "$TASK" "in_progress"

# ── Build the task instructions block ───────────────────────
TASK_INSTRUCTIONS="/tmp/copilot-task-instructions.md"

cat > "$TASK_INSTRUCTIONS" << TASKINSTR
# Agent Task Instructions

## Behaviour Rules

- Work **autonomously** — do not pause to ask for user confirmation.
- Use /allow-all permissions already granted; never prompt for approval.
- **Never** delete the repository root (/workspace) or run destructive
  commands such as \`rm -rf /workspace\` or \`git rm -r .\`.
- Commit progress frequently with descriptive commit messages.
- If you encounter an error, diagnose and fix it automatically.
- Continue working until **all tasks below are fully complete**.
- After completing each milestone, summarise what was done.

## Project Type

${PROJECT_TYPE}

## Testing Strategy

### Unit & Widget Tests (always run first — fast, no device needed)
\`\`\`bash
cd /workspace && flutter test 2>&1 | tee /tmp/test-results.txt
\`\`\`

### Device Tests via Firebase Test Lab
Firebase Test Lab is $([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "**ENABLED**" || echo "**DISABLED** (no credentials provided)").
$([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "Firebase project: \`${FIREBASE_PROJECT_ID}\`")
$([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "Target device:    \`${FIREBASE_TEST_DEVICE}\`")

\`\`\`bash
ftl-test android 2>&1 | tee /tmp/firebase-results.txt
\`\`\`

**Testing order:** flutter test → ftl-test android (if enabled)

## Reporting — REQUIRED at task completion

When all tasks are done, run:
\`\`\`bash
generate-report
\`\`\`

Record notes during work:
\`\`\`bash
echo "your note" >> /tmp/agent-notes.txt
\`\`\`

## Task / Goals

${TASK}
TASKINSTR

# ── Merge with resume context if resuming ───────────────────
INITIAL_PROMPT="$TASK"

if [ "$MODE" = "resume" ] && [ -n "$RESUME_PROMPT" ]; then
    INITIAL_PROMPT="$RESUME_PROMPT"
    log "Using resume context as initial prompt"
elif [ "$MODE" = "planned" ] && [ -f /workspace/PLAN.md ]; then
    INITIAL_PROMPT="Execute the plan in PLAN.md completely and autonomously.

$(cat /workspace/PLAN.md)

Work through each milestone in order. Commit after each one. Run tests.
When all milestones are done, run generate-report."
    log "Using PLAN.md as initial prompt"
fi

# ── Merge with global instructions ──────────────────────────
if [ -f /root/.copilot/copilot-instructions.md ]; then
    {
        cat /root/.copilot/copilot-instructions.md
        echo ""
        cat "$TASK_INSTRUCTIONS"
    } > /tmp/merged-instructions.md
    cp /tmp/merged-instructions.md /root/.copilot/copilot-instructions.md
else
    cp "$TASK_INSTRUCTIONS" /root/.copilot/copilot-instructions.md
fi

ok "Instructions written to /root/.copilot/copilot-instructions.md"

# ── Start Copilot via tmux ───────────────────────────────────
TMUX_SESSION="copilot-agent"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

log "Starting tmux session (mode=$MODE)..."
tmux new-session -d -s "$TMUX_SESSION" -x 240 -y 50

tmux send-keys -t "$TMUX_SESSION" \
    "export GH_TOKEN='${GH_TOKEN}'; cd /workspace && copilot --experimental" Enter

sleep 8

# ── Activate autopilot (Shift+Tab × 2) ──────────────────────
log "Activating autopilot mode..."
tmux send-keys -t "$TMUX_SESSION" BTab
sleep 1
tmux send-keys -t "$TMUX_SESSION" BTab
sleep 1

# ── Grant all permissions ────────────────────────────────────
log "Granting all permissions..."
tmux send-keys -t "$TMUX_SESSION" "/allow-all" Enter
sleep 2

# ── If resuming, try native /resume first ───────────────────
if [ "$MODE" = "resume" ] && [ -n "$COPILOT_RESUME_CMD" ]; then
    log "Attempting native Copilot session resume..."
    tmux send-keys -t "$TMUX_SESSION" "$COPILOT_RESUME_CMD" Enter
    sleep 3
fi

# ── Submit the task / resume prompt ─────────────────────────
log "Submitting prompt to Copilot..."
tmux send-keys -t "$TMUX_SESSION" "$INITIAL_PROMPT" Enter

# ── Capture session ID for future resume ────────────────────
# Poll ~/.copilot for the newest session file and extract its ID
(
    sleep 15
    SESSION_ID=$(ls -t /root/.copilot/sessions/ 2>/dev/null | head -1 | sed 's/\.json//')
    if [ -n "$SESSION_ID" ]; then
        save_session_state "$TASK" "in_progress" "$SESSION_ID"
        log "Session ID captured: $SESSION_ID"
    fi
    # Touch checkpoint every 5 minutes while tmux session is alive
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
        sleep 300
        touch_checkpoint
    done
) &
CHECKPOINT_PID=$!

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Copilot agent running in autopilot mode     ║${NC}"
echo -e "${BOLD}║  Mode: ${MODE}                                    ${NC}"
echo -e "${BOLD}║                                              ║${NC}"
echo -e "${BOLD}║  Ctrl+C to detach (agent keeps going)        ║${NC}"
echo -e "${BOLD}║  tmux attach -t copilot-agent  to rejoin     ║${NC}"
echo -e "${BOLD}║  docker start <name>  to resume if stopped   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Attach and wait ──────────────────────────────────────────
tmux attach-session -t "$TMUX_SESSION" || true

# ── Post-session: kill checkpoint loop, generate report ─────
kill $CHECKPOINT_PID 2>/dev/null || true
echo ""
log "Copilot session ended — generating change report..."
generate-report
mark_session_complete

