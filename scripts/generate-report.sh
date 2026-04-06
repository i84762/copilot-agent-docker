#!/bin/bash
# ============================================================
# generate-report.sh — Write change summary to /workspace
# Called by Copilot agent at task completion, and also run
# automatically by the container after Copilot exits.
# Output: /workspace/.copilot-reports/YYYY-MM-DD_HH-MM-SS/
# ============================================================

REPORT_DIR="/workspace/.copilot-reports/$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$REPORT_DIR"

BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[report]${NC} $1"; }
ok()  { echo -e "${GREEN}[✓]${NC} $1"; }

SESSION_START="${AGENT_SESSION_START:-unknown}"
SESSION_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PROJECT_TYPE=$(cat /tmp/project_type 2>/dev/null || echo "unknown")
TASK=$(cat /tmp/copilot-task-instructions.md 2>/dev/null | \
       sed -n '/^## Task \/ Goals/,$ { /^## Task \/ Goals/d; p }' | \
       head -40)

log "Generating reports in $REPORT_DIR ..."

# ── 1. SUMMARY.md ────────────────────────────────────────────
cat > "$REPORT_DIR/SUMMARY.md" << EOF
# Copilot Agent — Session Summary

| Field          | Value |
|----------------|-------|
| Session start  | ${SESSION_START} |
| Session end    | ${SESSION_END} |
| Project type   | ${PROJECT_TYPE} |
| Firebase       | ${FIREBASE_ENABLED:-disabled} |
| Working dir    | /workspace |

## Task Given

\`\`\`
${TASK}
\`\`\`

## Commits Made This Session

$(cd /workspace 2>/dev/null && \
  git log --oneline --since="${SESSION_START}" \
          --format="- \`%h\` %s  *(by %an, %ar)*" 2>/dev/null \
  || echo "_No git history available_")

## Files Changed

$(cd /workspace 2>/dev/null && \
  git diff --name-status HEAD~$(git rev-list --count HEAD --since="${SESSION_START}" 2>/dev/null || echo 1) HEAD 2>/dev/null \
  | awk '{ printf "- **%s** %s\n", $1, $2 }' \
  || echo "_Could not determine changed files_")

## Test Results

$(cat /tmp/test-results.txt 2>/dev/null || echo "_No test results recorded_")

## Firebase Test Lab Results

$(cat /tmp/firebase-results.txt 2>/dev/null || echo "_Firebase Test Lab not run_")

## Blockers / Notes

$(cat /tmp/agent-notes.txt 2>/dev/null || echo "_None recorded_")
EOF

# ── 2. CHANGES.diff ──────────────────────────────────────────
(cd /workspace 2>/dev/null && \
  git diff HEAD~$(git rev-list --count HEAD --since="${SESSION_START}" 2>/dev/null || echo 1) HEAD \
  > "$REPORT_DIR/CHANGES.diff" 2>/dev/null) || \
  echo "# No diff available" > "$REPORT_DIR/CHANGES.diff"

# ── 3. COMMIT_LOG.txt ────────────────────────────────────────
(cd /workspace 2>/dev/null && \
  git log --stat --since="${SESSION_START}" \
  > "$REPORT_DIR/COMMIT_LOG.txt" 2>/dev/null) || \
  echo "No git log available" > "$REPORT_DIR/COMMIT_LOG.txt"

# ── 4. TEST_RESULTS.txt ──────────────────────────────────────
cp /tmp/test-results.txt   "$REPORT_DIR/TEST_RESULTS.txt"   2>/dev/null || \
  echo "No test results" > "$REPORT_DIR/TEST_RESULTS.txt"
cp /tmp/firebase-results.txt "$REPORT_DIR/FIREBASE_RESULTS.txt" 2>/dev/null || true

# ── 5. FILES_CHANGED.txt (flat list) ────────────────────────
(cd /workspace 2>/dev/null && \
  git diff --name-only HEAD~$(git rev-list --count HEAD --since="${SESSION_START}" 2>/dev/null || echo 1) HEAD \
  > "$REPORT_DIR/FILES_CHANGED.txt" 2>/dev/null) || \
  echo "No file list available" > "$REPORT_DIR/FILES_CHANGED.txt"

# ── 6. Latest symlink for easy access ────────────────────────
ln -sfn "$REPORT_DIR" /workspace/.copilot-reports/latest

ok "Reports written to: $REPORT_DIR"
echo ""
echo -e "${BOLD}📋 Review your reports at (on Windows host):${NC}"
echo -e "   ${CYAN}.copilot-reports\\$(basename $REPORT_DIR)\\${NC}"
echo -e "   Key files:"
echo -e "   • SUMMARY.md       — what was done, commits, test results"
echo -e "   • CHANGES.diff     — full unified diff of all code changes"
echo -e "   • COMMIT_LOG.txt   — detailed git log with file stats"
echo -e "   • FILES_CHANGED.txt — flat list of modified files"
echo ""
