#!/usr/bin/env python3
"""Render a fully resolved TrueNAS YAML without reading token file contents."""
import argparse, json, os, re, subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image-tag', required=True, help='Published sha-<commit> or version tag')
parser.add_argument('--mcp-token-file', default='/mnt/tank/apps/obsidian-mcp/secrets/mcp-token',
                    help='Absolute MCP bearer-token file path on the host')
parser.add_argument('--tunnel-token-file', default='/mnt/tank/apps/obsidian-mcp/secrets/tunnel-token',
                    help='Absolute tunnel-token file path on the host')
parser.add_argument('--without-tunnel', action='store_true', help='Omit cloudflared for another transport')
args = parser.parse_args()
for name in ['mcp_token_file', 'tunnel_token_file']:
    if not Path(getattr(args, name)).is_absolute():
        parser.error(f'--{name.replace("_", "-")} must be absolute')
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', args.image_tag):
    parser.error('Invalid image tag')
repo = Path(__file__).resolve().parent.parent
env = dict(os.environ,
    OBSIDIAN_MCP_AUTH_TOKEN_FILE=args.mcp_token_file,
    OBSIDIAN_MCP_TUNNEL_TOKEN_FILE=args.tunnel_token_file,
    OBSIDIAN_MCP_SYNC_IMAGE=f'ghcr.io/glitchassassin/obsidian-mcp-sync:{args.image_tag}',
    OBSIDIAN_MCP_COMMANDER_IMAGE=f'ghcr.io/glitchassassin/obsidian-mcp-desktop-commander:{args.image_tag}')
command = ['docker', 'compose', '--env-file', '/dev/null', '-f', str(repo/'compose.yaml'), 'config']
if args.without_tunnel:
    # JSON is valid YAML; remove the connector and its unused secret declaration.
    result = subprocess.run(command+['--format','json'], env=env, check=True, capture_output=True, text=True)
    model = json.loads(result.stdout)
    del model['services']['cloudflared']
    del model['secrets']['tunnel-token']
    print(json.dumps(model, indent=2))
else:
    subprocess.run(command, env=env, check=True)
