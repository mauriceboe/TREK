FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# better-sqlite3 and other native npm modules
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
