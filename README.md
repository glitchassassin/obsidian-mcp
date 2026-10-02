# Obsidian Sync + Desktop Commander MCP

Three containers: official Obsidian Headless Sync, Desktop Commander behind an authenticated Streamable HTTP proxy, and Cloudflare Tunnel. Only the vault directory is shared between Sync and MCP. This extracts the working bootlace v4 experiment into a deployable project; the original experiment was tested end-to-end with ChatGPT through Cloudflare MCP Portal.

## Images and CI

GitHub Actions builds both Dockerfile targets for `linux/amd64`, the TrueNAS target, and loads the images locally. Tests run before registry login and publication. The workflow publishes those exact tested images, without rebuilding them:

- `ghcr.io/glitchassassin/obsidian-mcp-sync:sha-<full-commit>`
- `ghcr.io/glitchassassin/obsidian-mcp-desktop-commander:sha-<full-commit>`

Main pushes also update `latest`. Git tags such as `v0.1.1` publish matching image tags. Pull requests build and test without publishing. Official Actions are pinned by commit; npm dependencies and the Node base image are pinned. Native ARM64 builds remain possible locally, but the publication workflow currently targets AMD64.

The runtime tests cover bearer rejection and authenticated initialization, file reads/writes and grep, exact-byte PNG/PDF/arbitrary binary writes, private Sync credential isolation, first-run initialization of an empty Commander bind mount, persistence through a restart, and the Sync native SQLite module. No real Obsidian or Cloudflare credentials are used in CI. Live Sync and Portal tests remain deployment checks.

GHCR packages are private by default when first created. The repository and images are intended to be public: after first publication, set each package's visibility to Public in GitHub package settings and verify an anonymous pull. A public repository alone does not guarantee public container packages.

## TrueNAS deployment

Use Docker-based TrueNAS 24.10 or newer and **Apps → Discover → Install via YAML**. Create datasets/directories before installation, for example:

```text
/mnt/tank/apps/obsidian-mcp/
  vault/
  sync-config/
  commander-state/
  secrets/mcp-token
  secrets/tunnel-token
  app.env
```

Give UID/GID 1000 write access to vault, sync-config, and commander-state. Keep Sync and Commander state private. The MCP token file must be readable by UID 1000 (owner 1000, mode 600 is sufficient). The Tunnel token can be root-owned mode 600. Tokens are mounted separately, read-only; neither belongs in Git, Docker build arguments, the YAML, or `app.env`.

For a new deployment, generate an independent random MCP key and store it in `secrets/mcp-token`. For migration, privately copy the current gateway key so the Portal's stored bearer credential keeps working. Save the connector token (the value after `--token` in Cloudflare's install command) in `secrets/tunnel-token`.

Copy `.env.example` to `app.env`, set the actual dataset root, and choose published immutable image tags instead of `latest`. Commander initializes its default config on an empty bind mount and preserves existing config on subsequent starts.

### Install from GitHub or a local file

TrueNAS accepts `include:` in its YAML editor. Recent Docker Compose versions support a Git repository URL as the included path; use the short wrapper in `deploy/truenas-include.example.yaml`. The Git URL points at a release tag and `compose.yaml`. Change the placeholder release tag to one that exists. Keep local settings in the wrapper's `env_file` on the NAS.

This requires the Compose version bundled with your TrueNAS release to support remote Git resources, and has not yet been tested on your NAS. It is not a raw GitHub URL import field, and it does not continuously track upstream changes. Updates require choosing a new pinned revision and redeploying.

For older Compose versions, download a release's Compose file to the dataset and paste the two-line local wrapper in `deploy/truenas-local-include.example.yaml`. Alternatively, paste a fully rendered configuration:

```sh
python3 scripts/render-truenas.py --data-dir /mnt/tank/apps/obsidian-mcp \
  --image-tag sha-<full-published-commit> > compose.rendered.yaml
```

Run this on a machine with Docker Compose installed. It resolves all paths and image names without reading token file contents. `--without-tunnel` produces a valid YAML/JSON configuration containing only Sync and MCP for staging the migration.

References: [TrueNAS custom apps](https://apps.truenas.com/managing-apps/installing-custom-apps/), [Compose remote includes](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/), [Compose Git resources](https://docs.docker.com/reference/cli/docker/compose/).

### Authenticate Sync and cut over

Stage Sync and MCP first using the renderer's `--without-tunnel` option. In TrueNAS's shell for the Sync container, run:

```sh
ob login
ob sync-list-remote
ob sync-setup --vault "My Vault" --path /vault --device-name truenas
```

Passwords are entered at the CLI prompts. Sync waits until a vault is linked, then applies bidirectional mode and all attachment categories and starts continuously. Plugin/settings syncing is disabled. Let the initial vault download finish before cutover. Credentials persist only in sync-config.

Stop the old laptop's cloudflared connector before deploying the full three-service configuration on the NAS. Both locations can connect to the same tunnel, so overlapping connectors can send Portal requests to either vault replica. Retaining the tunnel, `vault-v4.internal` alias, and MCP token preserves the existing Portal endpoint: `http://vault-v4.internal:8000/mcp`. Confirm Ready status and run a real ChatGPT read/write and attachment round trip after migration. No host port needs to be exposed.

Snapshot the vault and state datasets before updates. Update pinned image references, redeploy, and confirm Sync and MCP status. Sync readiness is separate from the MCP gateway's `/healthz` check.

## Local builds and tests

```sh
docker build --target sync -t obsidian-mcp-test-sync:local .
docker build --target mcp -t obsidian-mcp-test-commander:local .
OBSIDIAN_MCP_SYNC_IMAGE=obsidian-mcp-test-sync:local \
OBSIDIAN_MCP_COMMANDER_IMAGE=obsidian-mcp-test-commander:local \
  scripts/ci-test.sh
```

On macOS/Colima, set `TMPDIR=/private/tmp` if the default temporary directory is not shared with Docker. The test script owns and removes only its uniquely named disposable Compose project and fixture directory; it does not touch the working v4 stack.

## Tools and privacy

Desktop Commander exposes file, search, and terminal tools. Supported images can use base64 `write_file`; existing PDFs and arbitrary binaries use `start_process` with Python/curl. The proxy caps incoming JSON at 4 MiB. Select client-visible tools in MCP Portal.

File tools are initially limited to `/vault`; shell tools can access the MCP container's filesystem and its independent gateway key. Sync account credentials and encryption keys are not mounted there. Desktop Commander telemetry is disabled by environment and configuration; local call history still records arguments and bounded output. See [SECURITY.md](SECURITY.md) for the targeted review and limitations.
