#!/bin/bash
# agents/copilot.sh — Launch GitHub Copilot CLI in autopilot mode via tmux
# Called by launch-agent.sh after common setup is done.
# Expects: $TASK, $MODE, $INITIAL_PROMPT, $TMUX_SESSION, $TASK_INSTRUCTIONS

log()  { echo -e "${CYAN}[copilot]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

[ -z "$GH_TOKEN" ] && { echo -e "${RED}[✗]${NC} GH_TOKEN is required for the copilot agent."; exit 1; }

# Write instructions to Copilot home
if [ -f /root/.copilot/copilot-instructions.md ]; then
    { cat /root/.copilot/copilot-instructions.md; echo ""; cat "$TASK_INSTRUCTIONS"; } \
        > /tmp/merged-instructions.md
    cp /tmp/merged-instructions.md /root/.copilot/copilot-instructions.md
else
    mkdir -p /root/.copilot
    cp "$TASK_INSTRUCTIONS" /root/.copilot/copilot-instructions.md
fi
ok "Instructions written to /root/.copilot/copilot-instructions.md"

# Start tmux session
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
log "Starting tmux session (mode=$MODE)..."
tmux new-session -d -s "$TMUX_SESSION" -x 240 -y 50

tmux send-keys -t "$TMUX_SESSION" \
    "export GH_TOKEN='${GH_TOKEN}'; cd /workspace && copilot --experimental" Enter
sleep 8

# Activate autopilot (Shift+Tab × 2)
log "Activating autopilot mode..."
tmux send-keys -t "$TMUX_SESSION" BTab; sleep 1
tmux send-keys -t "$TMUX_SESSION" BTab; sleep 1

# Grant all permissions
log "Granting all permissions..."
tmux send-keys -t "$TMUX_SESSION" "/allow-all" Enter
sleep 2

# Native session resume
if [ "$MODE" = "resume" ] && [ -n "$COPILOT_RESUME_CMD" ]; then
    log "Attempting native Copilot session resume..."
    tmux send-keys -t "$TMUX_SESSION" "$COPILOT_RESUME_CMD" Enter
    sleep 3
fi

# Submit the task prompt
log "Submitting prompt..."
tmux send-keys -t "$TMUX_SESSION" "$INITIAL_PROMPT" Enter

# Capture session ID in background
(
    sleep 15
    SESSION_ID=$(ls -t /root/.copilot/sessions/ 2>/dev/null | head -1 | sed 's/\.json//')
    [ -n "$SESSION_ID" ] && save_session_state "$TASK" "in_progress" "$SESSION_ID" \
        && log "Session ID captured: $SESSION_ID"
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
        sleep 300; touch_checkpoint
    done
) &
CHECKPOINT_PID=$!

print_banner "Copilot (autopilot)" "$MODE"
tmux attach-session -t "$TMUX_SESSION" || true
kill $CHECKPOINT_PID 2>/dev/null || true
