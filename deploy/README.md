# Deployment

The default deployment uses TrueNAS as the host, the three services in [compose.yaml](../compose.yaml), and Cloudflare MCP Portal as the external aggregator. You can replace the host, tunnel, and aggregator independently as described in the [architecture](../README.md#adaptation-points).

## Automatic storage

Docker creates three named volumes when you install the app: `vault-data`, `sync-config`, and `commander-state`. Sync and Desktop Commander share the vault; each has its own private state volume. Volume names are scoped to the Compose project, so keep the same TrueNAS app name across updates.

You don't need to create vault directories or datasets, set their ownership, or run an initialization container. New volumes inherit the mount directories prepared in the images: UID/GID 1000, with private state directories set to mode 700. Commander seeds its configuration once and preserves it afterward.

Named volumes persist through container recreation. They are Docker-managed storage, separate from TrueNAS ixVolumes. Avoid `docker compose down --volumes` for ordinary shutdown or updates. Back up the vault and private state using volume-aware tooling; individual volumes aren't separately provisioned ZFS datasets. Check the deletion options before removing the app in TrueNAS.

Existing host-path data isn't imported automatically. If you're upgrading a populated deployment, stop its writers and copy the vault and state into the new volumes before allowing clients to use them. Sync can download the vault again, but Commander configuration and history need a copy if you want to retain them.

## Token files

Provide just two host files, at these default paths:

```text
/mnt/tank/apps/obsidian-mcp/secrets/mcp-token
/mnt/tank/apps/obsidian-mcp/secrets/tunnel-token
```

The parent can be an existing private location; it doesn't need a new application dataset. Use an independent random bearer key for `mcp-token` and the Cloudflare connector token for `tunnel-token`. You can reuse your existing keys when moving the deployment.

Compose grants `mcp-token` only to Desktop Commander and `tunnel-token` only to cloudflared, mounted read-only under `/run/secrets`. Token values aren't environment variables or YAML fields. Obsidian credentials come from interactive login and persist in the private Sync volume.

Set the MCP token file's owner to UID/GID 1000 and mode 600; the tunnel file can be root-owned with mode 600. File-backed Compose secrets preserve the host file's permissions; Compose's secret `uid`/`gid` settings don't remap file-backed sources. Keep token contents out of Git, build arguments, and settings files.

TrueNAS's custom YAML workflow doesn't document a managed secret-store interface. File-backed [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/) are the mechanism used here; they expose existing host files and don't encrypt or provision them. You can supply those files manually or through your own secret manager.

## Install on TrueNAS

Use a Docker-based TrueNAS release (24.10 or newer). Prepare the token files, then open **Apps → Discover → Install via YAML** and paste [truenas-include.example.yaml](truenas-include.example.yaml). Give the app a stable name such as `obsidian-mcp`. The wrapper loads the release's Compose file, pinned images, automatic volumes, and default token paths from GitHub.

If you need different token paths or image references, copy [.env.example](../.env.example) to a non-secret `app.env` on the NAS and use the long include form:

```yaml
include:
  - path: https://github.com/glitchassassin/obsidian-mcp.git#v0.2.0:compose.yaml
    env_file: /absolute/path/app.env
```

Remote Git includes require support in the host's Compose version. If unavailable, download the release's `compose.yaml` and use [truenas-local-include.example.yaml](truenas-local-include.example.yaml), adding a local `env_file` if needed. Updates require explicitly changing the revision and redeploying.

You can also render a complete configuration on a machine with Docker Compose:

```sh
python3 scripts/render-truenas.py --image-tag v0.2.0 \
  --mcp-token-file /mnt/tank/apps/obsidian-mcp/secrets/mcp-token \
  --tunnel-token-file /mnt/tank/apps/obsidian-mcp/secrets/tunnel-token \
  > compose.rendered.yaml
```

Paste the result into the YAML editor. Rendering resolves token paths without reading their contents. `--without-tunnel` is available for deployments using another transport; initial Sync setup doesn't require it.

On another Docker host, provide the token files and run `docker compose up -d` from the repository. Use `--env-file /absolute/path/app.env` if you need to override defaults.

References: [TrueNAS custom apps](https://apps.truenas.com/managing-apps/installing-custom-apps/), [Compose volumes](https://docs.docker.com/reference/compose-file/volumes/), [Compose includes](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/).

## Connect Obsidian Sync

The Sync service stays available for interactive setup until a vault is linked. Open the Sync container's shell in TrueNAS, or run `docker compose exec sync bash` on another Docker host. Inside the container:

```sh
ob login
ob sync-list-remote
ob sync-setup --vault "My Vault" --path /vault --device-name obsidian-mcp
```

Enter passwords at the CLI prompts. The service then applies its configured settings and runs continuously. Defaults enable bidirectional synchronization and all attachment categories; plugin and settings synchronization is disabled. Account credentials and encryption keys persist in the private `sync-config` volume.

Wait for the initial download before using the vault through MCP. The gateway's health endpoint doesn't indicate whether Sync is current. You can run all three services during setup, but stop any previous connector using the same tunnel before starting this one.

## Connect the tunnel and MCP clients

Configure Cloudflare routing so the connector can reach `http://obsidian-mcp.internal:8000/mcp`. That hostname is a Compose network alias, resolvable by cloudflared inside the stack. Use the routing arrangement required by your Cloudflare connection mode; it's not a public client URL by itself.

In MCP Portal, configure the Streamable HTTP origin and the bearer credential matching `mcp-token`. Select the tools your clients may access, then connect your client to Portal's endpoint. Routing, Portal configuration, and client authorization are external setup steps.

For another aggregator, configure its upstream endpoint and bearer credential. For direct access, provide a client-reachable route and send `Authorization: Bearer <mcp-token>`. Client-facing HTTP access should use TLS. The gateway itself doesn't filter Desktop Commander's tool list.

Verify an authenticated note read/write and an attachment transfer through your client route. Missing or incorrect bearer keys should receive HTTP 401.

## Updates and backups

Back up the named volumes before updates, change the Compose revision and image references, and redeploy under the same app name. Check Sync status and MCP access afterward. Update the upstream routing or credential if you change the internal hostname or bearer key. Recreate the consuming container after replacing a host secret file so it mounts the current file.

Treat vault backups, Sync state, Commander history, and container logs as private data. Avoid routing a single MCP endpoint to multiple independent vault replicas unless that request distribution is intentional.
