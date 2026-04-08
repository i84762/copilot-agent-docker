#!/bin/bash
# ============================================================
# resume-session.sh — Reconstruct context for interrupted sessions
# Called by entrypoint.sh when an incomplete session is detected.
# Outputs a RESUME_PROMPT and sets RESUME_SESSION_ID.
# ============================================================

source /usr/local/bin/session-state.sh

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[resume]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# ── Load saved state ─────────────────────────────────────────
eval "$(load_session_state)"  # sets RESUME_TASK, RESUME_STATUS, RESUME_SESSION_ID, etc.

log "Resuming session (last checkpoint: ${RESUME_LAST_CHECKPOINT:-unknown})"

# ── What was completed? (git log since session start) ────────
COMPLETED_WORK=""
if [ -n "$RESUME_GIT_SHA_START" ] && [ "$RESUME_GIT_SHA_START" != "none" ]; then
    COMPLETED_WORK=$(cd /workspace && git log \
        --oneline \
        "${RESUME_GIT_SHA_START}..HEAD" \
        --format="- %s (%ar)" 2>/dev/null || echo "")
fi

# ── What files changed since session start? ─────────────────
CHANGED_FILES=""
if [ -n "$RESUME_GIT_SHA_START" ] && [ "$RESUME_GIT_SHA_START" != "none" ]; then
    CHANGED_FILES=$(cd /workspace && git diff --name-only \
        "${RESUME_GIT_SHA_START}" HEAD 2>/dev/null | head -30 || echo "")
fi

# ── Load the plan if available ───────────────────────────────
PLAN_CONTENT=""
if [ -f /workspace/PLAN.md ]; then
    PLAN_CONTENT=$(cat /workspace/PLAN.md)
elif [ -f "$RESUME_PLAN_FILE" ] && [ "$RESUME_PLAN_FILE" != "none" ]; then
    PLAN_CONTENT=$(cat "$RESUME_PLAN_FILE" 2>/dev/null || echo "")
fi

# ── Try Copilot native /resume first ────────────────────────
# If ~/.copilot is persisted (via the copilot-home symlink), Copilot
# may still have the session in its store. We capture the session ID
# at start time and try to resume it.
COPILOT_RESUME_CMD=""
if [ -n "$RESUME_SESSION_ID" ] && [ "$RESUME_SESSION_ID" != "unknown" ]; then
    COPILOT_RESUME_CMD="/resume ${RESUME_SESSION_ID}"
    log "Will attempt native Copilot session resume: $COPILOT_RESUME_CMD"
fi

# ── Build resume context prompt ──────────────────────────────
export RESUME_PROMPT="RESUMING INTERRUPTED SESSION

## Original Task
${RESUME_TASK}

## Plan
$([ -n "$PLAN_CONTENT" ] && echo "$PLAN_CONTENT" || echo "No PLAN.md found — infer from the original task and current code state.")

## What Was Already Done (git commits since session started)
$([ -n "$COMPLETED_WORK" ] && echo "$COMPLETED_WORK" || echo "No commits recorded since session start — check git log manually.")

## Files Modified This Session
$([ -n "$CHANGED_FILES" ] && echo "$CHANGED_FILES" || echo "No file changes recorded.")

## Instructions
- Review the above to understand what was already done.
- Check the current state of the codebase to verify the completed work.
- Identify what milestones are still outstanding from the plan.
- Continue working autonomously from where the session left off.
- Do NOT redo work that is already committed.
- If something was partially done, assess whether it needs to be completed or fixed.
- Run tests to verify existing changes are sound before proceeding.
- Complete all remaining tasks and then run generate-report."

export COPILOT_RESUME_CMD

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           RESUMING PREVIOUS SESSION                 ║${NC}"
echo -e "${BOLD}║                                                      ║${NC}"

if [ -n "$COMPLETED_WORK" ]; then
    echo -e "${BOLD}║  ✅ Commits found — resuming from checkpoint         ║${NC}"
else
    echo -e "${BOLD}║  ⚠  No commits found — starting fresh with context  ║${NC}"
fi

if [ -n "$PLAN_CONTENT" ]; then
    echo -e "${BOLD}║  📋 PLAN.md loaded                                   ║${NC}"
fi

echo -e "${BOLD}║                                                      ║${NC}"
echo -e "${BOLD}║  Last checkpoint: ${RESUME_LAST_CHECKPOINT:-unknown}        ${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
