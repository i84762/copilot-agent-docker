#!/bin/bash
# ============================================================
# plan-mode.sh — Interactive planning session
# Copilot reads the codebase + task, asks the user clarifying
# questions, suggests improvements, and writes PLAN.md.
# Sourced/called by entrypoint.sh when COPILOT_PLAN_MODE=true
# ============================================================

TASK="$1"
PROJECT_TYPE=$(cat /tmp/project_type 2>/dev/null || echo "unknown")

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[plan]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# ── Build the planning prompt ────────────────────────────────
PLANNING_PROMPT="You are in PLANNING MODE. Do NOT write any code yet.

## Your job right now

1. **Explore the codebase** — understand the project structure, architecture,
   key files, existing patterns, and tech stack. Use shell commands and file
   reads to build a thorough picture.

2. **Understand the task** — the user wants:
   ---
   ${TASK}
   ---

3. **Identify gaps** — think critically about:
   - Ambiguities in the requirements
   - Missing information you need to do a complete job
   - Potential conflicts with the existing codebase
   - Edge cases that aren't addressed
   - Dependencies or integrations not mentioned

4. **Ask clarifying questions** — present a numbered list of questions.
   Wait for the user to answer EACH one before proceeding.
   Do not ask all questions at once if some depend on earlier answers.

5. **Suggest improvements** — after questions are answered, propose any
   improvements or additions that would make the outcome better. Let the
   user decide which to include.

6. **Write PLAN.md** — once all questions are answered and scope is agreed,
   write a structured plan to /workspace/PLAN.md containing:
   - Summary of agreed scope
   - Ordered list of milestones (each self-contained and testable)
   - For each milestone: what will be built, files affected, acceptance criteria
   - Testing strategy
   - Any risks or assumptions

7. **Confirm** — show the user the plan and ask: 'Does this plan look good?
   Reply YES to save it, or tell me what to change.'
   Keep refining until the user approves.

8. **Save and exit** — when approved, save PLAN.md and print:
   PLAN READY — run the container again without --plan to start execution.

Start by exploring the project structure now."

# ── Write as instruction file so it loads automatically ──────
mkdir -p /root/.copilot
cat > /root/.copilot/copilot-instructions.md << PLANINSTR
# Planning Session Instructions

${PLANNING_PROMPT}
PLANINSTR

ok "Planning instructions written"

# ── Checkpoint: save state as 'planning' ─────────────────────
save_session_state "$TASK" "in_progress"

# ── Start Copilot in INTERACTIVE mode (no autopilot) ─────────
TMUX_SESSION="copilot-plan"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

log "Starting interactive planning session..."
tmux new-session -d -s "$TMUX_SESSION" -x 220 -y 50

tmux send-keys -t "$TMUX_SESSION" \
    "export GH_TOKEN='${GH_TOKEN}'; cd /workspace && copilot --experimental" Enter

# Wait for CLI to load
sleep 8

# Grant dir access (but do NOT enable autopilot — stay interactive)
tmux send-keys -t "$TMUX_SESSION" "/allow-all" Enter
sleep 2

# Submit the planning prompt — Copilot will start exploring and questioning
tmux send-keys -t "$TMUX_SESSION" "$PLANNING_PROMPT" Enter

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           PLANNING MODE — Interactive Session        ║${NC}"
echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}║  Copilot is analysing your code and task.            ║${NC}"
echo -e "${BOLD}║  Answer its questions to refine the plan.            ║${NC}"
echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}║  When done: PLAN.md will be saved to your project.   ║${NC}"
echo -e "${BOLD}║  Then re-run WITHOUT --plan to start execution.      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# Attach so user can interact
tmux attach-session -t "$TMUX_SESSION" || true

# ── After user exits the planning session ────────────────────
if [ -f /workspace/PLAN.md ]; then
    ok "PLAN.md saved to /workspace/PLAN.md"
    save_session_state "$TASK" "planned"
    echo ""
    echo -e "${BOLD}Plan saved. Run the container again without --plan to execute.${NC}"
    echo ""
    echo -e "${CYAN}Plan preview:${NC}"
    head -50 /workspace/PLAN.md
else
    warn "PLAN.md was not created. You can create it manually or re-run --plan."
    save_session_state "$TASK" "planned"
fi
