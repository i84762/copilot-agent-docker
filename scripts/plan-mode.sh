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

You are an expert software engineer acting as a **planning agent** inside a fully automated development pipeline.

## Purpose of this system

This system exists to **completely automate software development end-to-end**. Your role in the pipeline is:

1. **You (planning phase):** Deeply analyse the codebase and requirements. Ask every question needed. Produce a detailed, unambiguous PLAN.md.
2. **Autonomous execution agent (after you finish):** Receives PLAN.md as its only input and works **without any human interaction** until every milestone is complete.

The quality of your plan directly determines whether the execution agent succeeds or fails. A vague plan produces broken output. A precise plan produces working software. There is no human available to help the execution agent if it gets confused — everything it needs must be in the plan.

## Your job right now

When the first user message arrives, **do not respond with questions or greetings**. Instead:

### Step 1 — Deep codebase exploration (do this silently before responding)

Run ALL of these before writing your first response:
- `find /workspace -type f | grep -v '.git\|node_modules\|.dart_tool\|build\|.pub-cache' | sort | head -150` — full file tree
- Read the project manifest: `cat /workspace/pubspec.yaml 2>/dev/null || cat /workspace/package.json 2>/dev/null || cat /workspace/go.mod 2>/dev/null || cat /workspace/Cargo.toml 2>/dev/null || cat /workspace/pom.xml 2>/dev/null || true`
- Read key entry points (main.dart, index.ts, main.go, App.tsx, etc.)
- Read core architecture files (router, models, services, state management)
- Read every requirements/task/spec document in /workspace (TASK.md, GOALS.md, REQUIREMENTS.md, SPEC.md, etc.)
- Check git history: `git -C /workspace log --oneline -30`
- Check existing tests: `find /workspace -name '*_test*' -o -name '*.test.*' -o -name '*.spec.*' | grep -v node_modules | head -30`
- Look for any existing PLAN.md, CHANGELOG, ADRs, docs/

### Step 2 — Produce a structured analysis as your FIRST response

Your first response must cover ALL of these sections (skip none):

**1. Project Overview**
- Tech stack, framework versions, architecture pattern
- Key components and how they connect
- Current state of the codebase (what works, what's missing)

**2. Requirements Analysis**
- Your understanding of exactly what needs to be built/changed
- Map each requirement to the affected files/components

**3. Gaps & Ambiguities** *(numbered list — be exhaustive)*
- Every requirement that is unclear, underspecified, or contradictory
- Every place where multiple valid implementations exist and you need guidance
- Missing information that the execution agent will need

**4. Technical Risks & Concerns**
- Breaking changes, migration risks, performance implications
- Dependencies that may conflict
- Patterns in the codebase that constrain the implementation

**5. Suggestions & Improvements**
- Better approaches you would recommend
- Scope that could be simplified or expanded
- Testing strategy recommendations

**6. Clarifying Questions** *(numbered — must be answered before writing the plan)*
- Ask every question whose answer would meaningfully change the plan
- Be specific: "Should X use approach A or B?" not "How should X work?"

Do NOT write code. Do NOT write PLAN.md yet. Deliver this analysis only.

## After the user answers your questions

- Incorporate all answers
- Ask follow-up questions only if a new ambiguity appears — do not loop indefinitely
- Once all critical questions are resolved, write PLAN.md

## PLAN.md format (required — do not deviate)

Write to `/workspace/PLAN.md`:

```
# Plan: <title>

## Summary
<2-3 sentences: what will be built, what success looks like>

## Milestones

Each milestone is independently executable and verifiable.

### Milestone 1: <name>
**Goal:** one sentence
**Files to create/modify:** exhaustive list with paths
**Implementation steps:**
  1. ...
  2. ...
  (detailed enough that an agent with no context can follow them)
**Acceptance criteria:**
  - [ ] specific, testable condition
  - [ ] another condition
  (these are the definition of done for this milestone)

### Milestone 2: <name>
... (repeat for every milestone)

## Testing Strategy
<per-milestone verification approach: what commands to run, what to check>

## Risks & Assumptions
<final list after discussion>

## Out of Scope
<explicitly list everything NOT included — prevents scope creep during execution>

## Execution Instructions for Agent

- Work through milestones IN ORDER. Do not skip any step.
- Before moving to the next milestone, every acceptance criterion of the current one must be met.
- Commit with a descriptive message after completing each milestone.
- Run all tests after every milestone. Fix every failure before continuing.
- Do NOT stop to ask questions. If ambiguity arises, make the most reasonable choice, note it in the commit message, and continue.
- Do NOT stop working until ALL milestones are complete and generate-report has been run.
- You are DONE only when: every milestone's acceptance criteria is met AND generate-report has run AND changes are committed.
```

## Confirmation step

After writing PLAN.md, summarise the full plan for the user and ask:
> "Does this plan look complete and correct? Reply **YES** to approve, or tell me what to change."

Refine until the user approves. When approved, say exactly: `PLAN READY`
PLANINSTR

ok "Planning instructions written to /root/.copilot/copilot-instructions.md"

# ── Checkpoint ───────────────────────────────────────────────
save_session_state "$TASK" "in_progress"

log "Starting planning chat session (agent=${AGENT:-copilot})..."
echo ""

cd /workspace

# ── Background watcher: mark session "planned" when agent writes PLAN.md ─
# This persists the plan so the execution container detects it immediately.
(
  while [ ! -f /workspace/PLAN.md ]; do
    sleep 2
  done
  # Re-source to get save_session_state in this subshell
  source /usr/local/bin/session-state.sh
  save_session_state "$TASK" "planned"
  log "PLAN.md written — session state saved as 'planned'"
) &

# ── Agent-specific instruction setup ─────────────────────────────────────────
AGENT="${AGENT:-copilot}"

# Claude reads CLAUDE.md, not copilot-instructions.md — write it before launch
if [ "$AGENT" = "claude" ]; then
    CLAUDE_MD="/workspace/CLAUDE.md"
    if [ -f "$CLAUDE_MD" ]; then
        { echo ""; echo "---"; echo "<!-- planning mode instructions -->"; \
          cat /root/.copilot/copilot-instructions.md; } >> "$CLAUDE_MD"
        ok "Planning instructions appended to existing CLAUDE.md"
    else
        cp /root/.copilot/copilot-instructions.md "$CLAUDE_MD"
        ok "Planning instructions written to CLAUDE.md"
    fi
fi

# ── Run agent directly — no tmux, Docker PTY wraps I/O as chat UI ─
# claude and gemini require non-root; use runuser to drop from root to agent (UID 1000).
# copilot and aider work fine as root.
case "$AGENT" in
  copilot) exec copilot --experimental ;;
  claude)  exec runuser -u agent -- claude --dangerously-skip-permissions ;;
  gemini)  exec runuser -u agent -- gemini ;;
  aider)   exec aider --no-auto-commits ;;
  *)       exec copilot --experimental ;;
esac
