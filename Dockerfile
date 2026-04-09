FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PATH="/root/.local/bin:/sdks/flutter/bin:/usr/local/go/bin:/root/.cargo/bin:${PATH}"

# Base system tools (without nodejs — we install Node.js 20 LTS below)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git unzip zip xz-utils \
    python3 python3-pip \
    openjdk-17-jdk-headless \
    tmux expect \
    ca-certificates gnupg lsb-release \
    libglu1-mesa clang cmake ninja-build pkg-config \
    libgtk-3-dev liblzma-dev libstdc++-12-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS via NodeSource (required by claude-code and gemini-cli)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Copilot CLI
RUN curl -fsSL https://gh.io/copilot-install | bash

# Install Claude Code CLI (Anthropic)
RUN npm install -g @anthropic-ai/claude-code --quiet

# Install Gemini CLI (Google)
RUN npm install -g @google/gemini-cli --quiet

# Install Aider (multi-model coding agent)
RUN pip3 install aider-chat --quiet

# Install Google Cloud SDK (gcloud) for Firebase Test Lab
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
        https://packages.cloud.google.com/apt cloud-sdk main" \
        | tee /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# Install fastlane for Play Store / App Store delivery
# --force is needed because aider-chat installs a `dotenv` binary that conflicts
RUN apt-get update && apt-get install -y --no-install-recommends ruby ruby-dev \
    && gem install fastlane --quiet --no-document --force \
    && rm -rf /var/lib/apt/lists/*

# Cache directory for SDKs (can be mounted as a volume)
RUN mkdir -p /sdks /workspace

WORKDIR /workspace

COPY scripts/entrypoint.sh         /usr/local/bin/entrypoint.sh
COPY scripts/detect-and-install.sh /usr/local/bin/detect-and-install.sh
COPY scripts/launch-copilot.sh     /usr/local/bin/launch-agent.sh
COPY scripts/setup-firebase.sh     /usr/local/bin/setup-firebase.sh
COPY scripts/generate-report.sh    /usr/local/bin/generate-report.sh
COPY scripts/session-state.sh      /usr/local/bin/session-state.sh
COPY scripts/plan-mode.sh          /usr/local/bin/plan-mode.sh
COPY scripts/resume-session.sh     /usr/local/bin/resume-session.sh
COPY scripts/agents/               /usr/local/bin/agents/

# Strip Windows CRLF line endings so shebangs work on Linux
RUN apt-get update && apt-get install -y --no-install-recommends dos2unix \
    && dos2unix /usr/local/bin/entrypoint.sh \
               /usr/local/bin/detect-and-install.sh \
               /usr/local/bin/launch-agent.sh \
               /usr/local/bin/setup-firebase.sh \
               /usr/local/bin/generate-report.sh \
               /usr/local/bin/session-state.sh \
               /usr/local/bin/plan-mode.sh \
               /usr/local/bin/resume-session.sh \
    && find /usr/local/bin/agents -name '*.sh' -exec dos2unix {} + \
    && rm -rf /var/lib/apt/lists/*

RUN chmod +x \
    /usr/local/bin/entrypoint.sh \
    /usr/local/bin/detect-and-install.sh \
    /usr/local/bin/launch-agent.sh \
    /usr/local/bin/setup-firebase.sh \
    /usr/local/bin/generate-report.sh \
    /usr/local/bin/session-state.sh \
    /usr/local/bin/plan-mode.sh \
    /usr/local/bin/resume-session.sh \
    /usr/local/bin/agents/copilot.sh \
    /usr/local/bin/agents/claude.sh \
    /usr/local/bin/agents/gemini.sh \
    /usr/local/bin/agents/aider.sh

# Create a non-root user used ONLY for running the claude/gemini binaries.
# Claude Code blocks --dangerously-skip-permissions for UID 0, so we drop
# privileges with `runuser -u agent` just before launching the agent binary.
# The rest of the container (setup, git, session-state) keeps running as root.
RUN groupadd -g 1000 agent \
    && useradd -u 1000 -g 1000 -s /bin/bash -d /root agent

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
