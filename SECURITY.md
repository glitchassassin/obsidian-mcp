# Security and privacy

## Runtime boundaries

**Never expose the admin container publicly.** Its HTTP port is for trusted LAN administration. Don’t forward it, create a tunnel route to it, or add it to an MCP aggregator. The default port binding uses all host interfaces; set `ADMIN_BIND_IP` to a specific NAS LAN IPv4 address where needed. HTTP doesn’t encrypt browser-to-NAS traffic, so the default assumes a trusted private network.

The admin service is trusted with vault setup and credentials. It mounts private admin state, Sync configuration, the vault, and separate MCP/tunnel credential volumes. It runs as UID/GID 1000 with dropped capabilities, on its own Docker network. It has no Docker socket, host management API, or endpoint for arbitrary commands. Service supervisors observe credential-file changes and restart their own child processes.

Sync and Desktop Commander share `/vault`. Sync credentials, encryption keys, database, and logs remain in `sync-config`, accessible to Sync and admin. Desktop Commander mounts its own state and only its read-only MCP credential volume. cloudflared mounts only its read-only tunnel credential volume. The tunnel’s Docker network has no admin service name or shared network path. The host-published LAN port remains reachable from containers that can reach the NAS; network separation doesn’t prevent a deliberately configured tunnel route through the host address. Never configure such a route.

The gateway requires bearer authentication at `/mcp` before processing requests. Until setup is complete and a key is present, the gateway doesn’t start. Key regeneration replaces the stored token and restarts the gateway, dropping existing sessions. Supervisor health checks report availability, including waiting states, rather than live Sync or tunnel status.

Desktop Commander’s file-tool allowlist starts at `/vault`; terminal tools can access the MCP container’s filesystem, including its gateway key. The allowlist isn’t a shell sandbox. Authenticated clients should be trusted for the tools exposed to them. MCP Portal or another aggregator controls client authorization and tool filtering outside the stack.

## Admin authentication and setup

Creating the admin password is the only unauthenticated configuration action. Initialize it promptly on your trusted LAN; anyone who can reach an uninitialized UI can claim it. All further setup requires an admin session. Passwords use salted scrypt hashes; cookies are HttpOnly and SameSite=Strict. Sessions stay in memory, have an eight-hour maximum lifetime, and expire on restart. Login attempts are rate limited. JSON writes require a matching Origin and, once authenticated, a session CSRF token. Host validation, cross-site request rejection, and a restrictive content security policy reduce browser-origin attacks.

The account and vault binding is locked when the vault is selected. After initialization the server permits only re-authentication to the original account, MCP-key regeneration, and tunnel-token replacement. It doesn’t expose switching or unlinking controls. Account matching uses the email returned by Obsidian’s authenticated account endpoint. Host-level access can alter state; these controls aren’t a boundary against a trusted administrator of the NAS.

Obsidian passwords and MFA codes go only to the fixed Obsidian API over HTTPS and aren’t persisted. Login is verified before the stored token is replaced. Vault setup uses the pinned official CLI, with sensitive arguments supplied through a child’s stdin rather than OS command-line arguments. Raw CLI output and provider errors aren’t logged or returned.

The MCP key is cryptographically random. Only its creation/regeneration response exposes it to the UI; status endpoints never return existing keys or tunnel tokens. Responses use `Cache-Control: no-store`, and the UI keeps a new key only in the current page until dismissed or left. Credentials remain plaintext at rest where the services need them, in private mode-600 files. Named volumes don’t provide secret-store encryption.

## Data handling

Desktop Commander telemetry is disabled by environment and initial configuration. Its local tool history and container logs can contain arguments, base64 attachments, and command output. Keep Commander state and logs private alongside vault data and backups. Don’t give clients terminal access they shouldn’t have.

All storage is provisioned as named volumes. No credential values are embedded in Compose, environment variables, build arguments, or host token paths. The build context is an allowlist of source and locked dependencies. Back up all state and credential volumes together, and don’t commit credentials.

## Builds and validation

The Dockerfile pins the Node base image by digest, npm packages by lockfiles, and Supergateway by source revision. Debian packages installed during a build can change. Supergateway's pinned revision provides inbound bearer authentication. Third-party packages retain their own licenses and terms, including the official Obsidian Headless client.

Desktop Commander installation scripts are skipped and system ripgrep is supplied. A checked build-time patch disables automatic Chrome download during MCP initialization. Native PDF generation retains the upstream on-demand browser path; storing existing PDF bytes through Python requires no browser.

CI publishes the same AMD64 images that pass runtime tests using synthetic credentials. Tests cover admin setup and authentication, immutable account/vault selection, one-time key responses, cross-site request protection, login rate limits, MCP authentication and rotation of existing sessions, file and attachment operations, credential/network isolation, volume permissions, and persistence through container recreation. Obsidian account login, live Sync transfer, external routing policies, and host compatibility require verification in the deployment environment.
