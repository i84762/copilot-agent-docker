#!/bin/bash
# ============================================================
# setup-firebase.sh — Configure Firebase Test Lab + gcloud auth
# Sourced by entrypoint.sh
# ============================================================

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[firebase]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# Skip entirely if no Firebase project configured
if [ -z "$FIREBASE_PROJECT_ID" ]; then
    warn "FIREBASE_PROJECT_ID not set — Firebase Test Lab disabled"
    export FIREBASE_ENABLED=false
    return 0
fi

# ── Auth: service account key file (preferred) ──────────────
if [ -n "$GOOGLE_APPLICATION_CREDENTIALS" ] && \
   [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
    log "Authenticating gcloud with service account key..."
    gcloud auth activate-service-account \
        --key-file="$GOOGLE_APPLICATION_CREDENTIALS" --quiet
    ok "gcloud authenticated via service account key"

# ── Auth: inline JSON key passed as env var ──────────────────
elif [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
    log "Authenticating gcloud from GOOGLE_CREDENTIALS_JSON..."
    echo "$GOOGLE_CREDENTIALS_JSON" > /tmp/gcloud-key.json
    gcloud auth activate-service-account \
        --key-file=/tmp/gcloud-key.json --quiet
    export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcloud-key.json
    ok "gcloud authenticated via inline credentials"

else
    warn "No gcloud credentials found (GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON)."
    warn "Firebase Test Lab will not be available."
    export FIREBASE_ENABLED=false
    return 0
fi

# ── Set project ──────────────────────────────────────────────
gcloud config set project "$FIREBASE_PROJECT_ID" --quiet
ok "gcloud project set to: $FIREBASE_PROJECT_ID"

# ── Verify access ────────────────────────────────────────────
if gcloud firebase test android models list --quiet &>/dev/null; then
    ok "Firebase Test Lab access confirmed"
    export FIREBASE_ENABLED=true
else
    warn "Could not reach Firebase Test Lab (check IAM permissions)"
    export FIREBASE_ENABLED=false
fi

# ── Export helper env vars for the agent's instructions ──────
export FIREBASE_TEST_DEVICE="${FIREBASE_TEST_DEVICE:-model=oriole,version=33,locale=en,orientation=portrait}"
export FIREBASE_TEST_TIMEOUT="${FIREBASE_TEST_TIMEOUT:-5m}"

# Write a helper script the agent can call directly
cat > /usr/local/bin/ftl-test << 'FTLSCRIPT'
#!/bin/bash
# ftl-test — Run Flutter integration tests on Firebase Test Lab
# Usage:
#   ftl-test android   [apk_path] [test_apk_path]
#   ftl-test robo      [apk_path]
set -e

MODE="${1:-android}"
PROJECT_DIR="/workspace"
BUILD_DIR="$PROJECT_DIR/build/app/outputs/apk"

case "$MODE" in
  android)
    APP_APK="${2:-$BUILD_DIR/debug/app-debug.apk}"
    TEST_APK="${3:-$BUILD_DIR/androidTest/debug/app-debug-androidTest.apk}"

    echo "▶ Building debug APK..."
    (cd "$PROJECT_DIR" && flutter build apk --debug)
    echo "▶ Building instrumentation test APK..."
    (cd "$PROJECT_DIR" && flutter build apk --debug --target=integration_test/app_test.dart)

    echo "▶ Running on Firebase Test Lab (${FIREBASE_TEST_DEVICE})..."
    gcloud firebase test android run \
      --type instrumentation \
      --app     "$APP_APK" \
      --test    "$TEST_APK" \
      --device  "$FIREBASE_TEST_DEVICE" \
      --timeout "$FIREBASE_TEST_TIMEOUT" \
      --project "$FIREBASE_PROJECT_ID"
    ;;

  robo)
    APP_APK="${2:-$BUILD_DIR/debug/app-debug.apk}"
    echo "▶ Building debug APK..."
    (cd "$PROJECT_DIR" && flutter build apk --debug)

    echo "▶ Running Robo test on Firebase Test Lab..."
    gcloud firebase test android run \
      --type    robo \
      --app     "$APP_APK" \
      --device  "$FIREBASE_TEST_DEVICE" \
      --timeout "$FIREBASE_TEST_TIMEOUT" \
      --project "$FIREBASE_PROJECT_ID"
    ;;

  *)
    echo "Usage: ftl-test [android|robo] [apk] [test-apk]"
    exit 1
    ;;
esac
FTLSCRIPT
chmod +x /usr/local/bin/ftl-test
ok "ftl-test helper available at /usr/local/bin/ftl-test"
