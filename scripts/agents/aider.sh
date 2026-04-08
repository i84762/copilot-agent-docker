#!/bin/bash
# agents/aider.sh — Launch Aider (supports OpenAI, Anthropic, Gemini, local models)
# Docs: https://aider.chat
# Called by launch-agent.sh after common setup is done.
# Expects: $TASK, $MODE, $INITIAL_PROMPT, $TMUX_SESSION, $TASK_INSTRUCTIONS

log()  { echo -e "${CYAN}[aider]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# Determine model and required key
AIDER_MODEL="${AIDER_MODEL:-}"

# Auto-detect model from available keys if not set explicitly
if [ -z "$AIDER_MODEL" ]; then
    if   [ -n "$ANTHROPIC_API_KEY" ]; then AIDER_MODEL="claude-3-5-sonnet-20241022"
    elif [ -n "$OPENAI_API_KEY" ];    then AIDER_MODEL="gpt-4o"
    elif [ -n "$GEMINI_API_KEY" ];    then AIDER_MODEL="gemini/gemini-1.5-pro"
    else
        echo -e "${RED}[✗]${NC} Aider needs at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY."
        echo      "      Set AIDER_MODEL to use a custom endpoint (e.g. ollama/mistral)."
        exit 1
    fi
fi
ok "Aider model: $AIDER_MODEL"

# Write instructions to .aider.agent.md (Aider reads this via --read)
AIDER_CONTEXT="/tmp/aider-context.md"
{
    if [ -f /root/.copilot/copilot-instructions.md ]; then
        cat /root/.copilot/copilot-instructions.md
        echo ""
        echo "---"
        echo ""
    fi
    cat "$TASK_INSTRUCTIONS"
} > "$AIDER_CONTEXT"
ok "Aider context written to $AIDER_CONTEXT"

# Build aider args
AIDER_ARGS=(
    --model "$AIDER_MODEL"
    --yes-always          # never prompt for confirmation
    --read "$AIDER_CONTEXT"
    --no-auto-commits     # we control commits
)

# Pass API keys as env (aider reads them from env automatically)
[ -n "$ANTHROPIC_API_KEY" ] && export ANTHROPIC_API_KEY
[ -n "$OPENAI_API_KEY" ]    && export OPENAI_API_KEY
[ -n "$GEMINI_API_KEY" ]    && export GEMINI_API_KEY

# ── Non-interactive (autonomous) run ────────────────────────────────────────
if [ "${AIDER_INTERACTIVE:-false}" != "true" ]; then
    log "Running Aider in autonomous mode (--message)..."
    print_banner "Aider ($AIDER_MODEL)" "$MODE"

    cd /workspace
    aider "${AIDER_ARGS[@]}" --message "$INITIAL_PROMPT"
    EXIT_CODE=$?
    [ $EXIT_CODE -ne 0 ] && warn "Aider exited with code $EXIT_CODE"
    return 0
fi

# ── Interactive mode ─────────────────────────────────────────────────────────
log "Starting Aider in interactive mode via tmux..."
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -x 240 -y 50

AIDER_CMD="cd /workspace && aider ${AIDER_ARGS[*]}"
tmux send-keys -t "$TMUX_SESSION" "$AIDER_CMD" Enter
sleep 6

log "Submitting prompt..."
tmux send-keys -t "$TMUX_SESSION" "$INITIAL_PROMPT" Enter

(
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
        sleep 300; touch_checkpoint
    done
) &
CHECKPOINT_PID=$!

print_banner "Aider ($AIDER_MODEL) interactive" "$MODE"
tmux attach-session -t "$TMUX_SESSION" || true
kill $CHECKPOINT_PID 2>/dev/null || true
