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

## Purpose

You are the **execution agent** in a fully automated development pipeline. A human planned this work, reviewed it, and approved it. There is **no human available** during execution. You must work continuously and autonomously until every goal is achieved. Do not stop. Do not ask questions. Do not wait.

## Behaviour Rules

- Work **autonomously** — do not pause to ask for confirmation, clarification, or approval.
- **Never** delete the repository root (/workspace) or run destructive commands such as \`rm -rf /workspace\` or \`git rm -r .\`.
- Commit progress frequently with descriptive commit messages.
- If you encounter an error: diagnose the root cause, fix it, and continue. Never give up on a milestone.
- If you hit ambiguity: make the most reasonable choice, document it in a commit message, and keep going.
- If a test fails: fix the failure before moving to the next milestone. Do not skip tests.
- Continue until **ALL milestones are fully complete and their acceptance criteria are met**.
- After each milestone: commit, then check off its acceptance criteria before moving on.
- You are DONE only when every milestone is complete, all tests pass, and generate-report has run.

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
elif [ -f /workspace/PLAN.md ]; then
    # A plan exists — use it regardless of mode flag so execution is always plan-driven
    PLAN_CONTENT=$(cat /workspace/PLAN.md)
    export INITIAL_PROMPT="## Your mission

You are an autonomous execution agent. A human reviewed and approved the plan below. Execute it **completely and without stopping** until every milestone is done and every acceptance criterion is met.

You are operating in a **fully automated pipeline** — there is no human to ask. Every decision is yours to make. Keep going.

### Non-negotiable rules
- Work through milestones **in order**. Do not skip any step or acceptance criterion.
- Before moving to the next milestone, verify every acceptance criterion of the current one.
- Commit with a descriptive message immediately after completing each milestone.
- Run all tests after every milestone. Fix every failure before continuing — never leave a failing test.
- **Never stop to ask questions.** If you hit ambiguity, make the most reasonable choice, note it in the commit message, and continue.
- **Never stop working** until ALL milestones are complete, all tests pass, and generate-report has been run.
- If you encounter an unexpected error or blocker: diagnose it, fix it, and continue. Do not give up.
- When fully done: run \`generate-report\`, commit, and push.

### Definition of DONE
You are done when ALL of the following are true:
1. Every milestone's acceptance criteria is checked off
2. All tests pass (run the full test suite to confirm)
3. \`generate-report\` has been run
4. All changes are committed with descriptive messages

---

## Approved Plan

${PLAN_CONTENT}

---

## Original Task (for reference)

${TASK}

---

Begin now with Milestone 1. Do not stop until you reach the Definition of DONE."
    log "Using PLAN.md as execution driver"
else
    # No plan — normal autonomous run
    export INITIAL_PROMPT="## Your mission

You are an autonomous execution agent in a fully automated development pipeline. There is no human available during execution.

Work **autonomously and continuously** until ALL goals below are fully implemented.

### Rules
- Do NOT stop to ask questions. Make reasonable decisions independently.
- If you hit an error: diagnose and fix it. Never give up on a goal.
- Commit progress frequently with descriptive messages.
- Run tests after each significant change. Fix every failure before continuing.
- You are DONE only when every goal is complete, all tests pass, and generate-report has run.
- When done: run \`generate-report\`, commit, and push.

## Task / Goals

${TASK}

Begin now."
    log "No PLAN.md found — running in autonomous mode"
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


