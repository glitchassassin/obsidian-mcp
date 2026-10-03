# Deployment

The default deployment uses TrueNAS as the host, the four services in [compose.yaml](../compose.yaml), and Cloudflare MCP Portal as the external aggregator. You can replace the host, tunnel, and aggregator independently as described in the [architecture](../README.md#adaptation-points).

## Install on TrueNAS

Use a Docker-based TrueNAS release (24.10 or newer). Open **Apps → Discover → Install via YAML**, paste [truenas-include.example.yaml](truenas-include.example.yaml), and give the app a stable name such as `obsidian-mcp`. The wrapper loads the release’s Compose file and pinned images from GitHub. Docker provisions storage automatically; you don’t need host token files or pre-created datasets.

Open `http://<NAS-LAN-IP>:8090` immediately after installation. The admin port defaults to all host interfaces, so restrict it to your trusted LAN. **Never expose the admin container publicly:** don’t forward its port, put it in MCP Portal, or configure a Cloudflare Tunnel route to it. The admin and tunnel containers have separate Docker networks.

If you want to bind only a specific LAN interface, change `ADMIN_BIND_IP` to the NAS’s LAN IPv4 address. `ADMIN_PORT` changes the published port. Access by IP works by default; add a hostname to `ADMIN_ALLOWED_HOSTS` if you prefer a local DNS name. The UI rejects other Host headers to reduce DNS rebinding exposure.

You can set these non-secret values in a local `app.env`, using [.env.example](../.env.example) and the long include form:

```yaml
include:
  - path: https://github.com/glitchassassin/obsidian-mcp.git#v0.3.0:compose.yaml
    env_file: /absolute/path/app.env
```

Remote Git includes require support in the host’s Compose version. If unavailable, download the release’s `compose.yaml` and use [truenas-local-include.example.yaml](truenas-local-include.example.yaml), or paste the full Compose file into the YAML editor. Updates require explicitly changing the revision and redeploying.

You can render fully resolved YAML on a machine with Docker Compose:

```sh
python3 scripts/render-truenas.py --image-tag v0.3.0 \
  --admin-bind-ip 192.168.1.20 > compose.rendered.yaml
```

Replace the example IP with your NAS’s LAN address. Rendering includes no credentials. `--without-tunnel` omits cloudflared and makes the tunnel-token setup step optional for another transport. On another Docker host, run `docker compose up -d` from the repository; use `--env-file /absolute/path/app.env` for overrides.

References: [TrueNAS custom apps](https://apps.truenas.com/managing-apps/installing-custom-apps/), [Compose volumes](https://docs.docker.com/reference/compose-file/volumes/), [Compose includes](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/).

## Complete setup in the browser

1. **Create an admin password** of at least 12 characters. All subsequent setup and administration require authenticated access. Only a salted scrypt hash is stored.
2. **Log into Obsidian** using your email, password, and two-factor code if enabled. The admin service sends these to Obsidian over HTTPS. Your account password and MFA code aren’t saved.
3. **Load and select your existing Sync vault.** Enter its encryption password if it uses end-to-end encryption; leave that field empty for standard encryption. Selection locks the deployment to this account and vault. Derived encryption credentials persist in the private Sync volume.
4. **Generate the MCP key and save it.** The UI displays it only in the creation response. Put it in MCP Portal’s upstream bearer credential or your MCP client. You can’t retrieve the existing key later.
5. **Save the Cloudflare connector token**, then choose **Finish setup**. Sync, the MCP gateway, and the tunnel start automatically. The containers stay available while setup is incomplete, without serving an unauthenticated MCP endpoint.

The admin UI uses HTTP on the trusted LAN. Your browser-to-NAS traffic, including entered passwords, isn’t encrypted by this default setup; use a private network you trust. Don’t run setup over public Wi-Fi or expose this port to the internet.

Wait for the initial Sync download before using the vault through MCP. Container health checks report whether each supervisor is available, including a waiting state; they don’t establish that the vault is current or the tunnel is connected. Check Sync logs or Obsidian on another device for live synchronization.

## Manage the initialized deployment

Log into the same admin UI with your admin password. You can re-authenticate **the original Obsidian account**, regenerate the MCP key, and replace the tunnel token. There are no account-switching, vault-switching, or unlink controls. The server enforces these restrictions independently of the UI. Account identity is locked to the email returned by Obsidian’s authenticated account endpoint; changing that account’s email requires deliberate offline migration.

Re-authentication stages a new Obsidian login and verifies its identity before replacing the stored token. A rejected login or different identity preserves the running credentials. Sync restarts automatically when the saved token changes.

Regenerating the MCP key shows the new value once, replaces the stored key, and restarts the gateway within a few seconds. Existing MCP sessions disconnect and the old key stops working. Update MCP Portal or your client with the replacement key. Replacing the tunnel token restarts cloudflared automatically. No Docker socket or host restart API is mounted into the admin container.

Admin sessions expire after 30 minutes of inactivity or eight hours and aren’t persisted across admin-container restarts. Log out when you finish. There’s no browser password-reset endpoint; recovering a lost admin password requires trusted host-level access to the private admin state. Don’t delete state or volumes to troubleshoot authentication, because those actions can remove deployment bindings or data.

## Connect the tunnel and MCP clients

Configure Cloudflare routing so the connector can reach `http://obsidian-mcp.internal:8000/mcp`. That hostname is a Compose network alias, resolvable by cloudflared inside the stack. Use the routing arrangement required by your Cloudflare connection mode; it isn’t a public client URL by itself. Stop any previous connector using the same tunnel before starting this deployment.

In MCP Portal, configure the Streamable HTTP origin and the generated bearer credential. Select the tools your clients may access, then connect your client to Portal’s endpoint. Routing, Portal configuration, and client authorization are external setup steps.

For another aggregator, configure its upstream endpoint and bearer credential. For direct access, provide a client-reachable route and send `Authorization: Bearer <mcp-key>`. Client-facing access should use TLS. The gateway itself doesn’t filter Desktop Commander’s tool list. If you omit cloudflared manually, also set `ADMIN_TUNNEL_REQUIRED=false` on the admin service.

Verify an authenticated note read/write and an attachment transfer through your client route. Missing or incorrect bearer keys should receive HTTP 401.

## Storage, updates, and backups

Docker creates six named volumes: `vault-data`, `sync-config`, `commander-state`, `admin-state`, `mcp-key`, and `tunnel-key`. Names are scoped to the Compose project, so keep the same TrueNAS app name across updates. New volumes inherit UID/GID 1000 from the images; private directories use mode 700 and credential files use mode 600. MCP and tunnel credential volumes are mounted read-only in their consuming containers.

Named volumes persist through container recreation. They are Docker-managed storage, separate from TrueNAS ixVolumes, and aren’t individually provisioned ZFS datasets. Avoid `docker compose down --volumes` during ordinary shutdown or updates. Check the deletion options before removing the app in TrueNAS.

Back up **all six volumes together** before updates, change the Compose revision and image references, and redeploy under the same app name. Check Sync status and MCP access afterward. Treat vault backups, credentials, admin state, Commander history, and container logs as private data.

Existing host-path data and older deployments without admin state aren’t automatically imported. This setup flow is for a fresh deployment; migrate an existing vault and its locked account/vault binding deliberately before using the wizard against existing storage. Don’t run two independent writers against the same local vault.
