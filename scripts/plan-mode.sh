#!/bin/bash
# ============================================================
# plan-mode.sh — Interactive planning session
# Copilot reads the codebase + task, asks the user clarifying
# questions, suggests improvements, and writes PLAN.md.
# Sourced/called by entrypoint.sh when COPILOT_PLAN_MODE=true
# ============================================================

#!/bin/bash
# ============================================================
# plan-mode.sh — Deep planning session
# Agent proactively explores codebase + requirements, returns
# thorough analysis + questions, iterates until PLAN.md agreed.
# Sourced by entrypoint.sh when COPILOT_PLAN_MODE=true
# ============================================================

TASK="$1"
PROJECT_TYPE=$(cat /tmp/project_type 2>/dev/null || echo "unknown")

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[plan]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# ── Build the initial planning context ───────────────────────
# Collect any existing task/requirements files in the project
TASK_DOCS=""
for f in TASK.md GOALS.md GOAL.md MISSION.md TODO.md REQUIREMENTS.md SPEC.md .copilot-task.md; do
    if [ -f "/workspace/$f" ]; then
        TASK_DOCS="${TASK_DOCS}\n### Contents of /workspace/${f}:\n$(cat /workspace/$f)\n"
    fi
done

# If a task file was explicitly specified via env, read it
if [ -n "$COPILOT_TASK_FILE" ] && [ -f "$COPILOT_TASK_FILE" ]; then
    TASK_DOCS="${TASK_DOCS}\n### Explicitly provided task file (${COPILOT_TASK_FILE}):\n$(cat $COPILOT_TASK_FILE)\n"
fi

# ── Write comprehensive planning instructions ────────────────
mkdir -p /root/.copilot
cat > /root/.copilot/copilot-instructions.md << 'PLANINSTR'
# PLANNING MODE — SYSTEM INSTRUCTIONS

You are an expert software engineer acting as a **planning agent**.

## Core purpose

This system exists to **fully automate software development**. When the user is happy with the plan you produce, an AI agent will execute it **completely autonomously without any further human intervention** until every goal is achieved. The plan you write must therefore be thorough, unambiguous, and complete enough that zero clarification will be needed during execution.

## What to do IMMEDIATELY (do not wait for user to ask)

As soon as this session starts:

1. **Explore the full codebase** — run these commands to understand the project:
   - `find /workspace -type f | grep -v '.git\|node_modules\|.dart_tool\|build' | head -100`
   - `cat /workspace/pubspec.yaml 2>/dev/null || cat /workspace/package.json 2>/dev/null || cat /workspace/go.mod 2>/dev/null || true`
   - Read key architecture files, main entry points, existing patterns
   - Check git log: `git -C /workspace log --oneline -20`
   - Check for any existing PLAN.md, TODO, CHANGELOG

2. **Read all requirements/task documents** — read every file mentioned in the task.

3. **Produce a structured analysis** in your FIRST response covering:
   - **Project overview** — tech stack, architecture, key components
   - **Requirements analysis** — what you understood from the task
   - **Gaps & ambiguities** — list every unclear or missing requirement (numbered)
   - **Technical concerns** — conflicts, risks, dependencies, breaking changes
   - **Scope questions** — numbered list of questions the user MUST answer before you can write a complete plan
   - **Suggestions** — improvements you'd recommend

Do NOT write code. Do NOT write PLAN.md yet. Just deliver the analysis.

## After the user answers your questions

- Incorporate answers, ask follow-ups only if genuinely needed
- When all ambiguities are resolved, write a **complete PLAN.md** to `/workspace/PLAN.md`

## PLAN.md format (required structure)

```
# Plan: <title>

## Summary
<2-3 sentence agreed scope>

## Milestones
Each milestone must be independently executable and testable.

### Milestone 1: <name>
**Goal:** ...
**Files to create/modify:** ...
**Implementation steps:** (detailed, numbered)
**Acceptance criteria:** (specific, testable)

### Milestone 2: ...
(repeat)

## Testing Strategy
<how each milestone will be verified>

## Risks & Assumptions
<list>

## Out of Scope
<explicitly list what is NOT included>
```

## Execution directive (written into PLAN.md)

At the END of PLAN.md, always append:

```
## Execution Instructions for Agent

- Work through milestones IN ORDER. Do not skip any step.
- Each milestone must pass its acceptance criteria before moving to the next.
- Commit after completing each milestone with a descriptive message.
- Run tests after every milestone. Fix failures before continuing.
- Do NOT stop to ask questions. If you hit an ambiguity, make the most reasonable choice and note it.
- After ALL milestones are complete: run `generate-report`, commit, push.
- You are DONE only when every milestone's acceptance criteria is met and generate-report has run.
```

## Confirmation step

After writing PLAN.md, show the user a summary and ask:
> "Does this plan look complete? Reply **YES** to approve and save, or tell me what to change."

Keep refining until approved. Only say "PLAN READY" when the user has explicitly approved.
PLANINSTR

ok "Planning instructions written to /root/.copilot/copilot-instructions.md"

# ── Checkpoint ───────────────────────────────────────────────
save_session_state "$TASK" "in_progress"

log "Starting planning chat session (agent=${AGENT:-copilot})..."
echo ""

cd /workspace

# ── Run agent directly — no tmux, Docker PTY wraps I/O as chat UI ─
AGENT="${AGENT:-copilot}"
case "$AGENT" in
  copilot) exec copilot --experimental ;;
  claude)  exec claude --dangerously-skip-permissions ;;
  gemini)  exec gemini ;;
  aider)   exec aider --no-auto-commits ;;
  *)       exec copilot --experimental ;;
esac
