FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV HOME=/home/node
RUN mkdir -p /vault /home/node/.config /home/node/.claude-server-commander \
 && chown -R node:node /vault /home/node

FROM base AS sync-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY images/sync/package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
 && npm cache clean --force

FROM base AS sync
COPY --from=sync-deps /app/node_modules /app/node_modules
COPY --chmod=755 scripts/run-sync.sh /app/scripts/run-sync.sh
ENV PATH=/app/node_modules/.bin:$PATH XDG_CONFIG_HOME=/home/node/.config
USER node
WORKDIR /vault
CMD ["/app/scripts/run-sync.sh"]

FROM base AS gateway-deps
# Published 4.1.0 lacks the repository's bearer authentication. Build the exact
# reviewed revision; its lockfile pins the build and runtime npm dependencies.
RUN git init /gateway \
 && cd /gateway \
 && git remote add origin https://github.com/supercorp-ai/supergateway.git \
 && git fetch --depth 1 origin b5b9c85fdafe78be507ad4c5b057ba67bb7827aa \
 && git checkout --detach FETCH_HEAD \
 && npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS mcp
COPY images/mcp/package*.json ./
# Skip installation tracking and bundled ripgrep downloads; use system ripgrep.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY scripts/disable-chrome-prefetch.mjs /app/scripts/disable-chrome-prefetch.mjs
RUN node /app/scripts/disable-chrome-prefetch.mjs
COPY --from=gateway-deps /gateway/dist /opt/supergateway/dist
COPY --from=gateway-deps /gateway/package.json /opt/supergateway/package.json
COPY --from=gateway-deps /gateway/LICENSE /opt/supergateway/LICENSE
COPY --from=gateway-deps /gateway/node_modules /opt/supergateway/node_modules
COPY config/commander.json /app/config/commander.json
COPY scripts/seed-commander.mjs /app/scripts/seed-commander.mjs
COPY --chmod=755 scripts/run-mcp.sh /app/scripts/run-mcp.sh
COPY scripts/smoke-test.mjs /app/scripts/smoke-test.mjs
ENV PATH=/app/node_modules/.bin:$PATH \
    DESKTOP_COMMANDER_DISABLE_TELEMETRY=1 \
    SHELL=/bin/bash \
    NODE_ENV=production
USER node
WORKDIR /vault
CMD ["/app/scripts/run-mcp.sh"]
