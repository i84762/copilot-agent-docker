#!/bin/bash
# agents/claude.sh — Launch Claude Code CLI (Anthropic)
# Docs: https://docs.anthropic.com/en/docs/claude-code
# Called by launch-agent.sh after common setup is done.
# Expects: $TASK, $MODE, $INITIAL_PROMPT, $TMUX_SESSION, $TASK_INSTRUCTIONS

log()  { echo -e "${CYAN}[claude]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

[ -z "$ANTHROPIC_API_KEY" ] && { echo -e "${RED}[✗]${NC} ANTHROPIC_API_KEY is required for the claude agent."; exit 1; }

# Write project-level instructions to CLAUDE.md (Claude Code's system context file)
CLAUDE_MD="/workspace/CLAUDE.md"
{
    # Prepend global instructions if available
    if [ -f /root/.copilot/copilot-instructions.md ]; then
        cat /root/.copilot/copilot-instructions.md
        echo ""
        echo "---"
        echo ""
    fi
    cat "$TASK_INSTRUCTIONS"
} > /tmp/claude-context.md

# If CLAUDE.md already exists in project, append our instructions
if [ -f "$CLAUDE_MD" ]; then
    {
        echo ""; echo "---"
        echo "<!-- injected by copilot-agent-docker -->"
        cat /tmp/claude-context.md
    } >> "$CLAUDE_MD"
    ok "Appended instructions to existing CLAUDE.md"
else
    cp /tmp/claude-context.md "$CLAUDE_MD"
    ok "Created CLAUDE.md with task instructions"
fi

# Export key
export ANTHROPIC_API_KEY

# ── Non-interactive (autonomous) run ────────────────────────────────────────
if [ "${CLAUDE_INTERACTIVE:-false}" != "true" ]; then
    log "Running Claude Code in autonomous mode (--print)..."
    print_banner "Claude Code (autonomous)" "$MODE"

    # claude -p runs non-interactively; --dangerously-skip-permissions skips all prompts
    claude -p "$INITIAL_PROMPT" \
        --dangerously-skip-permissions \
        --allowedTools "all"
    EXIT_CODE=$?

    [ $EXIT_CODE -ne 0 ] && warn "Claude exited with code $EXIT_CODE"
    return 0
fi

# ── Interactive mode (plan or when CLAUDE_INTERACTIVE=true) ─────────────────
log "Starting Claude Code in interactive mode via tmux..."
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -x 240 -y 50

tmux send-keys -t "$TMUX_SESSION" \
    "export ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}'; cd /workspace && claude --dangerously-skip-permissions" Enter
sleep 5

# Submit initial prompt
log "Submitting prompt..."
tmux send-keys -t "$TMUX_SESSION" "$INITIAL_PROMPT" Enter

# Checkpoint loop
(
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
        sleep 300; touch_checkpoint
    done
) &
CHECKPOINT_PID=$!

print_banner "Claude Code (interactive)" "$MODE"
tmux attach-session -t "$TMUX_SESSION" || true
kill $CHECKPOINT_PID 2>/dev/null || true
