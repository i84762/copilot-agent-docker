#!/bin/bash
# ============================================================
# launch-agent.sh — Build task context and dispatch to the
#                   selected agent (copilot | claude | gemini | aider)
# Usage: launch-agent.sh "<task>" [normal|resume|planned]
# ============================================================

TASK="$1"
MODE="${2:-normal}"
AGENT="${AGENT:-copilot}"
PROJECT_TYPE=$(cat /tmp/project_type 2>/dev/null || echo "unknown")

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[launch]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

source /usr/local/bin/session-state.sh
save_session_state "$TASK" "in_progress"

# ── Shared banner helper (used by agent scripts) ─────────────────────────────
print_banner() {
    local agent_label="$1"
    local mode_label="$2"
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║  Agent : ${agent_label}${NC}"
    echo -e "${BOLD}║  Mode  : ${mode_label}${NC}"
    echo -e "${BOLD}║                                              ║${NC}"
    echo -e "${BOLD}║  Ctrl+C to detach (agent keeps going)        ║${NC}"
    echo -e "${BOLD}║  tmux attach -t copilot-agent  to rejoin     ║${NC}"
    echo -e "${BOLD}║  docker start <name>  to resume if stopped   ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
    echo ""
}
export -f print_banner

# ── Build task instructions block ────────────────────────────────────────────
export TASK_INSTRUCTIONS="/tmp/agent-task-instructions.md"
FIREBASE_STATUS=$([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "**ENABLED**" || echo "**DISABLED** (no credentials provided)")

cat > "$TASK_INSTRUCTIONS" << TASKINSTR
# Agent Task Instructions

## Behaviour Rules

- Work **autonomously** — do not pause to ask for user confirmation.
- **Never** delete the repository root (/workspace) or run destructive
  commands such as \`rm -rf /workspace\` or \`git rm -r .\`.
- Commit progress frequently with descriptive commit messages.
- If you encounter an error, diagnose and fix it automatically.
- Continue working until **all tasks below are fully complete**.
- After completing each milestone, summarise what was done.

## Project Type

${PROJECT_TYPE}

## Testing Strategy

### Unit & Widget Tests
\`\`\`bash
cd /workspace && flutter test 2>&1 | tee /tmp/test-results.txt
\`\`\`

### Device Tests via Firebase Test Lab
Firebase Test Lab is ${FIREBASE_STATUS}.
$([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "Firebase project: \`${FIREBASE_PROJECT_ID}\`")

\`\`\`bash
ftl-test android 2>&1 | tee /tmp/firebase-results.txt
\`\`\`

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

# ── Build the initial prompt (normal / resume / planned) ─────────────────────
export INITIAL_PROMPT="$TASK"

if [ "$MODE" = "resume" ] && [ -n "$RESUME_PROMPT" ]; then
    export INITIAL_PROMPT="$RESUME_PROMPT"
    log "Using resume context as initial prompt"
elif [ "$MODE" = "planned" ] && [ -f /workspace/PLAN.md ]; then
    export INITIAL_PROMPT="Execute the plan in PLAN.md completely and autonomously.

$(cat /workspace/PLAN.md)

Work through each milestone in order. Commit after each one. Run tests.
When all milestones are done, run generate-report."
    log "Using PLAN.md as initial prompt"
fi

# Shared tmux session name
export TMUX_SESSION="copilot-agent"

log "Agent: ${AGENT} | Mode: ${MODE}"

# ── Dispatch to agent-specific launcher ──────────────────────────────────────
case "$AGENT" in
    copilot) source /usr/local/bin/agents/copilot.sh ;;
    claude)  source /usr/local/bin/agents/claude.sh  ;;
    gemini)  source /usr/local/bin/agents/gemini.sh  ;;
    aider)   source /usr/local/bin/agents/aider.sh   ;;
    *)
        echo -e "${RED}[✗]${NC} Unknown AGENT='${AGENT}'. Valid: copilot, claude, gemini, aider"
        exit 1
        ;;
esac

# ── Post-session ──────────────────────────────────────────────────────────────
echo ""
log "Agent session ended — generating change report..."
generate-report
mark_session_complete


