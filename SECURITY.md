# Source and deployment notes

This is a deployment wrapper for the working bootlace v4 experiment. It is a targeted source spot-check and isolation design, not a comprehensive dependency audit.

- Desktop Commander `0.2.52`, reviewed source commit `c774c3b505de990219637ecdc9a830c8772fae9d`. The npm lockfile includes package integrity; this does not attest that the published package exactly matches the source checkout.
- Official `obsidian-headless@0.0.14`, with its native SQLite dependency explicitly rebuilt. Auth tokens, encryption keys, database, and Sync logs stay in the Sync-only config dataset.
- Supergateway built from reviewed commit `b5b9c85fdafe78be507ad4c5b057ba67bb7827aa`, using that source's lockfile. Its inbound authentication was added in [PR #286](https://github.com/supercorp-ai/supergateway/pull/286) after the published 4.1.0 release. Building this commit includes the feature; 4.1.0 silently ignores the new environment variable because it predates that feature.
- Node `24.15.0-bookworm-slim` is pinned by multi-platform digest. Debian packages remain mutable. The workflow publishes only images that passed the runtime tests on AMD64.

Only `/vault` is shared between Sync and Desktop Commander. Sync uses a separate network. MCP has no Docker socket and mounts only the vault, its own state, and its gateway-key file. cloudflared mounts only its connector token. Runtime tokens are not included in the build context. Shell tools are intentionally enabled; the directory allowlist applies to file tools, not a shell sandbox.

Desktop Commander installation scripts are skipped and system ripgrep is supplied. `DESKTOP_COMMANDER_DISABLE_TELEMETRY=1` disables analytics independently of persisted configuration; initial config also disables telemetry. Local tool history and Docker logs can contain tool arguments, base64 data, and command output and should be treated as private.

A checked build-time patch removes Desktop Commander's automatic Chrome download on MCP initialization. Native PDF generation retains its upstream on-demand browser path; byte-for-byte PDF storage through Python needs no browser.

The gateway's `/healthz` endpoint is intentionally unauthenticated and exposes only availability. The MCP endpoint rejects missing/wrong keys before processing a request. CI verifies real HTTP rejection and authenticated tool calls using a synthetic key file. Real Obsidian login, Sync transfer, Cloudflare policy enforcement, and NAS CPU compatibility require deployment verification.
