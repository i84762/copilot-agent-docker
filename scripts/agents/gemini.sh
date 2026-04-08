#!/bin/bash
# agents/gemini.sh — Launch Google Gemini CLI
# Docs: https://github.com/google-gemini/gemini-cli
# Called by launch-agent.sh after common setup is done.
# Expects: $TASK, $MODE, $INITIAL_PROMPT, $TMUX_SESSION, $TASK_INSTRUCTIONS

log()  { echo -e "${CYAN}[gemini]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

[ -z "$GEMINI_API_KEY" ] && { echo -e "${RED}[✗]${NC} GEMINI_API_KEY is required for the gemini agent."; exit 1; }

# Write project-level instructions to GEMINI.md
GEMINI_MD="/workspace/GEMINI.md"
{
    if [ -f /root/.copilot/copilot-instructions.md ]; then
        cat /root/.copilot/copilot-instructions.md
        echo ""
        echo "---"
        echo ""
    fi
    cat "$TASK_INSTRUCTIONS"
} > /tmp/gemini-context.md

if [ -f "$GEMINI_MD" ]; then
    { echo ""; echo "---"; echo "<!-- injected by copilot-agent-docker -->"; cat /tmp/gemini-context.md; } >> "$GEMINI_MD"
    ok "Appended instructions to existing GEMINI.md"
else
    cp /tmp/gemini-context.md "$GEMINI_MD"
    ok "Created GEMINI.md with task instructions"
fi

export GEMINI_API_KEY

# Start via tmux (Gemini CLI is interactive by default; --yolo skips confirmation prompts)
log "Starting Gemini CLI via tmux (mode=$MODE)..."
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -x 240 -y 50

tmux send-keys -t "$TMUX_SESSION" \
    "export GEMINI_API_KEY='${GEMINI_API_KEY}'; cd /workspace && gemini --yolo" Enter
sleep 6

# Submit the task prompt
log "Submitting prompt..."
tmux send-keys -t "$TMUX_SESSION" "$INITIAL_PROMPT" Enter

# Checkpoint loop
(
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
        sleep 300; touch_checkpoint
    done
) &
CHECKPOINT_PID=$!

print_banner "Gemini CLI" "$MODE"
tmux attach-session -t "$TMUX_SESSION" || true
kill $CHECKPOINT_PID 2>/dev/null || true
