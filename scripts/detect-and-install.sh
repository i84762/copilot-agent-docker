#!/bin/bash
# ============================================================
# detect-and-install.sh — Auto-detect project type and install SDKs
# Sourced by entrypoint.sh so it can export env vars
# ============================================================

SDK_CACHE="/sdks"
mkdir -p "$SDK_CACHE"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[sdk-setup]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# ── Detect ──────────────────────────────────────────────────
detect_project_type() {
    local dir="${1:-/workspace}"

    if [ -f "$dir/pubspec.yaml" ]; then
        echo "flutter"
    elif find "$dir" -maxdepth 2 -name "pom.xml" 2>/dev/null | grep -q .; then
        echo "java-maven"
    elif find "$dir" -maxdepth 2 -name "build.gradle*" 2>/dev/null | grep -q .; then
        echo "java-gradle"
    elif [ -f "$dir/package.json" ]; then
        echo "nodejs"
    elif [ -f "$dir/requirements.txt" ] || [ -f "$dir/pyproject.toml" ] || [ -f "$dir/setup.py" ]; then
        echo "python"
    elif find "$dir" -maxdepth 2 -name "*.csproj" 2>/dev/null | grep -q . || \
         find "$dir" -maxdepth 2 -name "*.sln"   2>/dev/null | grep -q .; then
        echo "dotnet"
    elif [ -f "$dir/go.mod" ]; then
        echo "go"
    elif [ -f "$dir/Cargo.toml" ]; then
        echo "rust"
    elif [ -f "$dir/Gemfile" ]; then
        echo "ruby"
    else
        echo "unknown"
    fi
}

# ── Flutter ─────────────────────────────────────────────────
install_flutter() {
    local FLUTTER_VERSION="${FLUTTER_VERSION:-3.24.5}"
    local FLUTTER_DIR="$SDK_CACHE/flutter"

    if command -v flutter &>/dev/null || [ -x "$FLUTTER_DIR/bin/flutter" ]; then
        ok "Flutter found in cache, skipping download"
        export PATH="$FLUTTER_DIR/bin:$PATH"
        return
    fi

    log "Installing Flutter ${FLUTTER_VERSION}..."
    local ARCH; ARCH=$(uname -m)
    [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ] && FARCH="arm64" || FARCH="x64"

    local URL="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"
    curl -fsSL "$URL" | tar -xJ -C "$SDK_CACHE/"
    export PATH="$FLUTTER_DIR/bin:$PATH"
    echo "export PATH=\"$FLUTTER_DIR/bin:\$PATH\"" >> /etc/profile.d/sdks.sh

    # Dart LSP (ships with Flutter SDK)
    flutter precache --quiet 2>/dev/null || true
    ok "Flutter ${FLUTTER_VERSION} installed"

    # Set up Dart LSP config
    mkdir -p /root/.copilot
    cat > /root/.copilot/lsp-config.json << 'EOF'
{
  "lspServers": {
    "dart": {
      "command": "dart",
      "args": ["language-server", "--client-id=copilot-cli"],
      "fileExtensions": { ".dart": "dart" }
    }
  }
}
EOF
}

# ── Java (Maven) ─────────────────────────────────────────────
install_java_maven() {
    ok "Java available: $(java -version 2>&1 | head -1)"
    if ! command -v mvn &>/dev/null; then
        log "Installing Maven..."
        apt-get install -y maven -q 2>/dev/null || warn "Could not install Maven"
    fi
    ok "Maven ready"
}

# ── Java (Gradle) ────────────────────────────────────────────
install_java_gradle() {
    ok "Java available: $(java -version 2>&1 | head -1)"
    if [ -f "/workspace/gradlew" ]; then
        chmod +x /workspace/gradlew
        ok "Gradle wrapper ready"
    else
        warn "No gradlew found; ensure Gradle is in PATH or add a wrapper"
    fi
}

# ── Node.js ──────────────────────────────────────────────────
install_nodejs() {
    ok "Node.js available: $(node --version)"
    if [ -f "/workspace/package.json" ]; then
        log "Installing npm dependencies..."
        (cd /workspace && npm install --silent 2>/dev/null) || warn "npm install had errors"
    fi
    # TypeScript LSP
    if grep -q '"typescript"' /workspace/package.json 2>/dev/null; then
        npm install -g typescript-language-server typescript --silent 2>/dev/null || true
        mkdir -p /root/.copilot
        cat > /root/.copilot/lsp-config.json << 'EOF'
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "fileExtensions": {
        ".ts": "typescript", ".tsx": "typescript", ".js": "javascript"
      }
    }
  }
}
EOF
    fi
}

# ── Python ───────────────────────────────────────────────────
install_python() {
    ok "Python available: $(python3 --version)"
    if [ -f "/workspace/requirements.txt" ]; then
        log "Installing Python dependencies..."
        pip3 install -r /workspace/requirements.txt --quiet 2>/dev/null || warn "pip install had errors"
    elif [ -f "/workspace/pyproject.toml" ]; then
        pip3 install -e /workspace --quiet 2>/dev/null || warn "pip install had errors"
    fi
    # Python LSP
    pip3 install python-lsp-server --quiet 2>/dev/null || true
    mkdir -p /root/.copilot
    cat > /root/.copilot/lsp-config.json << 'EOF'
{
  "lspServers": {
    "python": {
      "command": "pylsp",
      "args": [],
      "fileExtensions": { ".py": "python" }
    }
  }
}
EOF
}

# ── .NET ─────────────────────────────────────────────────────
install_dotnet() {
    if command -v dotnet &>/dev/null; then
        ok ".NET available: $(dotnet --version)"
        return
    fi
    log "Installing .NET SDK (LTS)..."
    curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS \
        --install-dir /usr/share/dotnet --no-path 2>/dev/null
    ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
    ok ".NET installed"
}

# ── Go ────────────────────────────────────────────────────────
install_go() {
    if command -v go &>/dev/null; then
        ok "Go available: $(go version)"
        return
    fi
    local GO_VERSION="${GO_VERSION:-1.22.5}"
    local ARCH; ARCH=$(uname -m)
    [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ] && GOARCH="arm64" || GOARCH="amd64"
    log "Installing Go ${GO_VERSION}..."
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" \
        | tar -xz -C /usr/local/
    ln -sf /usr/local/go/bin/go /usr/local/bin/go
    ok "Go ${GO_VERSION} installed"
}

# ── Rust ──────────────────────────────────────────────────────
install_rust() {
    if command -v cargo &>/dev/null; then
        ok "Rust available: $(rustc --version)"
        return
    fi
    log "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --quiet
    source "$HOME/.cargo/env"
    echo 'source "$HOME/.cargo/env"' >> /etc/profile.d/sdks.sh
    ok "Rust installed"
}

# ── Ruby ──────────────────────────────────────────────────────
install_ruby() {
    if ! command -v ruby &>/dev/null; then
        log "Installing Ruby..."
        apt-get install -y ruby ruby-dev -q 2>/dev/null || warn "Could not install Ruby"
    fi
    ok "Ruby available: $(ruby --version)"
    if [ -f "/workspace/Gemfile" ]; then
        gem install bundler --quiet 2>/dev/null || true
        (cd /workspace && bundle install --quiet 2>/dev/null) || warn "bundle install had errors"
    fi
}

# ── Main ─────────────────────────────────────────────────────
PROJECT_TYPE=$(detect_project_type /workspace)
log "Detected project type: ${PROJECT_TYPE}"
echo "$PROJECT_TYPE" > /tmp/project_type

case "$PROJECT_TYPE" in
    flutter)     install_flutter ;;
    java-maven)  install_java_maven ;;
    java-gradle) install_java_gradle ;;
    nodejs)      install_nodejs ;;
    python)      install_python ;;
    dotnet)      install_dotnet ;;
    go)          install_go ;;
    rust)        install_rust ;;
    ruby)        install_ruby ;;
    unknown)     warn "Unknown project type; using base environment." ;;
esac

export COPILOT_PROJECT_TYPE="$PROJECT_TYPE"
