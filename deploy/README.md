# Deployment

The default deployment uses TrueNAS for hosting and storage, the three services in [compose.yaml](../compose.yaml), and Cloudflare MCP Portal as the external MCP aggregator. The host, tunnel, and aggregator can be replaced independently as described in the [architecture](../README.md#adaptation-points).

## Storage and settings

Create the directories and token files before starting the stack:

```text
/mnt/tank/apps/obsidian-mcp/
  vault/
  sync-config/
  commander-state/
  secrets/mcp-token
  secrets/tunnel-token
  app.env
```

Give UID/GID 1000 write access to `vault`, `sync-config`, and `commander-state`. Keep both state directories private. The MCP token must be readable by UID 1000; owner 1000 and mode 600 are sufficient. The tunnel token can be root-owned with mode 600. Tokens are mounted read-only in their respective containers.

Generate an independent random bearer key for `secrets/mcp-token`. Store the Cloudflare tunnel connector token in `secrets/tunnel-token`. Keep tokens and Obsidian credentials out of Git, build arguments, Compose YAML, and `app.env`.

Copy [.env.example](../.env.example) to `app.env`, set the actual data root, and choose published image references. Release or commit tags identify builds; digest references provide strict immutability. An empty `commander-state` directory receives the default configuration on first start; existing configuration is preserved.

## Install on TrueNAS

Use a Docker-based TrueNAS release (24.10 or newer) and **Apps → Discover → Install via YAML**. Paste [truenas-include.example.yaml](truenas-include.example.yaml), setting the desired Git revision and the absolute path to `app.env`. Compose loads the stack from that revision on GitHub.

Remote Git includes require support in the Compose version bundled with the host. If unavailable, download `compose.yaml` from the chosen revision and use [truenas-local-include.example.yaml](truenas-local-include.example.yaml). Both approaches require an explicit revision update and redeployment for upgrades.

Alternatively, render a complete configuration on a machine with Docker Compose:

```sh
python3 scripts/render-truenas.py --data-dir /mnt/tank/apps/obsidian-mcp \
  --image-tag v0.1.2 > compose.rendered.yaml
```

Paste the result into the YAML editor. The renderer resolves storage paths and image tags without reading token contents. `--without-tunnel` omits the connector for initial setup or a deployment using another transport.

On another Docker host, set up the same directories and run `docker compose --env-file /absolute/path/app.env up -d` from the repository. Set `OBSIDIAN_MCP_DATA_DIR` to that host's storage location.

References: [TrueNAS custom apps](https://apps.truenas.com/managing-apps/installing-custom-apps/), [Compose includes](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/), [Compose Git resources](https://docs.docker.com/reference/cli/docker/compose/).

## Connect Obsidian Sync

The Sync service remains available for interactive setup until a vault is linked. Open the Sync container's shell in TrueNAS, or run `docker compose --env-file /absolute/path/app.env exec sync bash` on a Docker host. Inside the container:

```sh
ob login
ob sync-list-remote
ob sync-setup --vault "My Vault" --path /vault --device-name obsidian-mcp
```

Enter passwords at the CLI prompts. After setup, the service applies its configured Sync settings and runs continuously. Defaults enable bidirectional synchronization and all attachment categories; plugin and settings synchronization is disabled. Account credentials and encryption keys persist in `sync-config`.

Wait for the initial download before allowing clients to use the vault. The MCP health endpoint checks gateway availability; it does not indicate whether Sync is current.

## Connect the tunnel and MCP clients

Configure Cloudflare routing so the tunnel connector can reach the MCP origin at `http://obsidian-mcp.internal:8000/mcp`. That hostname is a Compose network alias, resolvable by `cloudflared` inside the stack. Use the hostname/routing arrangement required by the selected Cloudflare connection mode; it is not a public client URL by itself.

In MCP Portal, configure the server's Streamable HTTP origin and its bearer credential using the value in `secrets/mcp-token`. Select the tools clients may access, then connect the client to Portal's endpoint. Tunnel routing, Portal configuration, and client authorization are external setup steps.

For another aggregator, configure its upstream endpoint and bearer credential. For direct access, configure a client-reachable route to the gateway and send `Authorization: Bearer <mcp-token>`. Client-facing HTTP access should use TLS. If the aggregator is omitted, apply any required tool restrictions at the server; the gateway itself does not filter Desktop Commander's tool list.

Verify an authenticated note read/write and an attachment transfer through the chosen client route. Missing or incorrect bearer keys should receive HTTP 401.

## Updates and backups

Snapshot the vault and state directories before updates. Update the Compose revision and image references, redeploy, and check Sync status and MCP access. When changing the internal hostname or bearer key, update the upstream configuration in the aggregator or client route as well.

Treat vault snapshots, Sync state, Commander history, and container logs as private data. Avoid routing a single MCP endpoint to multiple independent vault replicas unless the resulting request distribution is intentional.
