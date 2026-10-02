# Security and privacy

## Runtime boundaries

The Compose stack shares only `/vault` between Obsidian Headless Sync and Desktop Commander. Sync account credentials, encryption keys, database, and logs remain in its private `sync-config` named volume. Sync uses a separate network from the MCP service and tunnel connector.

Desktop Commander mounts the vault, its own state, and a read-only file-backed Compose secret for its gateway key. It has no Docker socket or Sync credential mount. Its file-tool allowlist starts at `/vault`; terminal tools can access the MCP container's filesystem, including its gateway key. The allowlist is not a shell sandbox. Authenticated clients should be trusted for the tools exposed to them.

The gateway requires bearer authentication at `/mcp` before processing requests. `/healthz` is unauthenticated and reports availability. The default stack publishes no host ports. Cloudflare Tunnel receives only its connector-token secret; routing and any aggregator's client authorization or tool filtering are configured outside the stack. Direct clients must supply the gateway token and receive all advertised tools unless the server configuration is changed.

## Data handling

Desktop Commander telemetry is disabled by both environment and initial configuration. Local tool history and container logs can contain arguments, base64 attachments, and command output. Keep Commander state and logs private alongside vault data and backups.

Compose creates separate named volumes for vault data and each service's state. Token contents come from runtime host files through Compose secrets and are excluded from the Docker build context. File-backed secrets retain host permissions; they are not an encrypted secret store. Do not commit credentials or pass them as build arguments. Give the MCP key file only the access needed by UID 1000; keep the tunnel token and Sync state private.

## Builds and validation

The Dockerfile pins the Node base image by digest, npm packages by lockfiles, and Supergateway by source revision. Debian packages installed during a build can change. Supergateway's pinned revision provides inbound bearer authentication. Third-party packages retain their own licenses and terms, including the official Obsidian Headless client.

Desktop Commander installation scripts are skipped and system ripgrep is supplied. A checked build-time patch disables automatic Chrome download during MCP initialization. Native PDF generation retains the upstream on-demand browser path; storing existing PDF bytes through Python requires no browser.

CI publishes the same AMD64 images that pass runtime tests using synthetic credentials. Tests cover HTTP authentication, file and attachment operations, credential mount isolation, automatic volume permissions, and persistence through container recreation. Obsidian account login, live Sync transfer, external routing policies, and host compatibility require verification in the deployment environment.
