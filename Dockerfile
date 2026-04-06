FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PATH="/root/.local/bin:/sdks/flutter/bin:/usr/local/go/bin:/root/.cargo/bin:${PATH}"

# Base system tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git unzip zip xz-utils \
    python3 python3-pip \
    openjdk-17-jdk-headless \
    nodejs npm \
    tmux expect \
    ca-certificates gnupg lsb-release \
    libglu1-mesa clang cmake ninja-build pkg-config \
    libgtk-3-dev liblzma-dev libstdc++-12-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Copilot CLI
RUN curl -fsSL https://gh.io/copilot-install | bash

# Install pexpect for Python-based automation
RUN pip3 install pexpect --quiet

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
RUN apt-get update && apt-get install -y --no-install-recommends ruby ruby-dev \
    && gem install fastlane --quiet --no-document \
    && rm -rf /var/lib/apt/lists/*

# Cache directory for SDKs (can be mounted as a volume)
RUN mkdir -p /sdks /workspace

WORKDIR /workspace

COPY scripts/entrypoint.sh         /usr/local/bin/entrypoint.sh
COPY scripts/detect-and-install.sh /usr/local/bin/detect-and-install.sh
COPY scripts/launch-copilot.sh     /usr/local/bin/launch-copilot.sh
COPY scripts/setup-firebase.sh     /usr/local/bin/setup-firebase.sh
COPY scripts/generate-report.sh    /usr/local/bin/generate-report.sh

RUN chmod +x \
    /usr/local/bin/entrypoint.sh \
    /usr/local/bin/detect-and-install.sh \
    /usr/local/bin/launch-copilot.sh \
    /usr/local/bin/setup-firebase.sh \
    /usr/local/bin/generate-report.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
