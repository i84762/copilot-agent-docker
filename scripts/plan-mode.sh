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

# ── Write planning instructions file (auto-loaded by agents that support it) ──
mkdir -p /root/.copilot
cat > /root/.copilot/copilot-instructions.md << 'PLANINSTR'
# Planning Session Instructions

You are in PLANNING MODE. Do NOT write any code yet.

## Your job right now

1. **Explore the codebase** — understand the project structure, architecture,
   key files, existing patterns, and tech stack. Use shell commands and file
   reads to build a thorough picture.

2. **Understand the task** — the user will describe what they want to build.

3. **Identify gaps** — think critically about ambiguities, missing information,
   conflicts, edge cases, and unmentioned dependencies.

4. **Ask clarifying questions** — present a numbered list. Wait for answers.

5. **Suggest improvements** — after questions are answered, propose any
   additions or changes. Let the user decide.

6. **Write PLAN.md** — once scope is agreed, write /workspace/PLAN.md with:
   - Summary of agreed scope
   - Ordered milestones (each self-contained and testable)
   - For each milestone: what to build, files affected, acceptance criteria
   - Testing strategy, risks, and assumptions

7. **Confirm** — ask "Does this plan look good? Reply YES to save it."

8. **Save and exit** — when approved, save PLAN.md and say "PLAN READY".

Start by greeting the user and exploring the project structure.
PLANINSTR

ok "Planning instructions written"

# ── Checkpoint: save state as 'planning' ─────────────────────
save_session_state "$TASK" "in_progress"

log "Starting chat session (agent=${AGENT:-copilot})..."
echo ""

cd /workspace

# ── Run agent directly — Docker PTY provides TTY, server wraps I/O as chat UI ──
AGENT="${AGENT:-copilot}"
case "$AGENT" in
  copilot)
    exec copilot --experimental
    ;;
  claude)
    exec claude --dangerously-skip-permissions
    ;;
  gemini)
    exec gemini
    ;;
  aider)
    exec aider --no-auto-commits
    ;;
  *)
    exec copilot --experimental
    ;;
esac
