#!/bin/bash
# ============================================================
# launch-copilot.sh — Start Copilot CLI in autopilot mode via tmux
# ============================================================

TASK="$1"
PROJECT_TYPE=$(cat /tmp/project_type 2>/dev/null || echo "unknown")
export AGENT_SESSION_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

BOLD='\033[1m'; CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${CYAN}[launch]${NC} $1"; }
ok()  { echo -e "${GREEN}[✓]${NC} $1"; }

# ── Write task to AGENTS.md-style file ──────────────────────
# Copilot reads instructions from AGENTS.md in cwd / git root.
# We write the task into a .copilot-agent-task.md and expose the
# dir via COPILOT_CUSTOM_INSTRUCTIONS_DIRS so it is always loaded.

TASK_INSTRUCTIONS="/tmp/copilot-task-instructions.md"

cat > "$TASK_INSTRUCTIONS" << TASKINSTR
# Agent Task Instructions

## Behaviour Rules

- Work **autonomously** — do not pause to ask for user confirmation.
- Use /allow-all permissions already granted; never prompt for approval.
- **Never** delete the repository root (/workspace) or run destructive
  commands such as \`rm -rf /workspace\` or \`git rm -r .\`.
- Commit progress frequently with descriptive commit messages.
- If you encounter an error, diagnose and fix it automatically.
- Continue working until **all tasks below are fully complete**.
- After completing each milestone, summarise what was done.

## Project Type

${PROJECT_TYPE}

## Testing Strategy

### Unit & Widget Tests (always run first — fast, no device needed)
\`\`\`bash
cd /workspace && flutter test
\`\`\`

### Device Tests via Firebase Test Lab
Firebase Test Lab is $([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "**ENABLED**" || echo "**DISABLED** (no credentials provided)").
$([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "Firebase project: \`${FIREBASE_PROJECT_ID}\`")
$([ "${FIREBASE_ENABLED:-false}" = "true" ] && echo "Target device:    \`${FIREBASE_TEST_DEVICE}\`")

A helper script is available at \`/usr/local/bin/ftl-test\`:

\`\`\`bash
# Run Flutter integration tests on Firebase Test Lab (real Android devices):
ftl-test android

# Run Robo (automated exploratory) test:
ftl-test robo

# Custom APK paths:
ftl-test android path/to/app.apk path/to/test.apk
\`\`\`

**Testing order to follow:**
1. Run \`flutter test\` (unit + widget) — fix any failures before proceeding
2. If Firebase Test Lab is enabled, run \`ftl-test android\` for integration tests
3. If Firebase Test Lab is disabled, document which integration tests need device access
4. Never skip step 1 to jump straight to device tests

## Reporting — REQUIRED at task completion

When **all tasks are done**, you MUST run the report generator before finishing:

\`\`\`bash
generate-report
\`\`\`

This writes a human-readable summary to \`/workspace/.copilot-reports/\` (visible on
the host) containing:
- A markdown summary of what was accomplished
- Full diff of all code changes
- Git commit log
- Test results

During the session, capture key notes using:
\`\`\`bash
# Append a note (blockers, decisions, caveats):
echo "your note here" >> /tmp/agent-notes.txt

# After running flutter test, save the output:
flutter test 2>&1 | tee /tmp/test-results.txt

# After Firebase Test Lab, save the output:
ftl-test android 2>&1 | tee /tmp/firebase-results.txt
\`\`\`

## Task / Goals

${TASK}
TASKINSTR

# Merge with any globally fetched instructions
if [ -f /root/.copilot/copilot-instructions.md ]; then
    # Prepend global instructions, then append task
    {
        cat /root/.copilot/copilot-instructions.md
        echo ""
        cat "$TASK_INSTRUCTIONS"
    } > /tmp/merged-instructions.md
    cp /tmp/merged-instructions.md /root/.copilot/copilot-instructions.md
else
    cp "$TASK_INSTRUCTIONS" /root/.copilot/copilot-instructions.md
fi

ok "Instructions written to /root/.copilot/copilot-instructions.md"

# ── Start Copilot CLI via tmux ───────────────────────────────
# tmux gives us a proper PTY so Copilot renders correctly and
# we can send key sequences programmatically.

TMUX_SESSION="copilot-agent"

# Kill any stale session
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

log "Starting tmux session '${TMUX_SESSION}'..."
tmux new-session -d -s "$TMUX_SESSION" -x 240 -y 50

# Start Copilot CLI with --experimental (needed for autopilot mode)
tmux send-keys -t "$TMUX_SESSION" \
    "export GH_TOKEN='${GH_TOKEN}'; cd /workspace && copilot --experimental" Enter

# Wait for CLI banner/prompt to appear (~8 seconds)
sleep 8

# Switch to Autopilot mode: Shift+Tab cycles interactive → plan → autopilot
# In tmux, BTab is the key name for Shift+Tab
log "Switching to autopilot mode (Shift+Tab × 2)..."
tmux send-keys -t "$TMUX_SESSION" BTab
sleep 1
tmux send-keys -t "$TMUX_SESSION" BTab
sleep 1

# Grant all permissions so Copilot never pauses for approvals
log "Granting all permissions (/allow-all)..."
tmux send-keys -t "$TMUX_SESSION" "/allow-all" Enter
sleep 2

# Submit the task prompt
log "Submitting task to Copilot..."
# Use ctrl+s to run while preserving terminal state cleanly
tmux send-keys -t "$TMUX_SESSION" "$TASK" Enter

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Copilot agent is running in autopilot mode  ║${NC}"
echo -e "${BOLD}║                                              ║${NC}"
echo -e "${BOLD}║  Press Ctrl+C to detach (agent keeps going)  ║${NC}"
echo -e "${BOLD}║  Run: tmux attach -t copilot-agent  to rejoin║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Attach to the session so the user can observe / interact
tmux attach-session -t "$TMUX_SESSION" || true

# ── Auto-generate report when Copilot exits ──────────────────
echo ""
echo -e "${CYAN}[copilot-agent]${NC} Copilot session ended — generating change report..."
generate-report
