#!/usr/bin/env python3
"""Render a fully resolved TrueNAS YAML without any embedded credentials."""
import argparse, json, os, re, subprocess, ipaddress
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image-tag', required=True, help='Published sha-<commit> or version tag')
parser.add_argument('--admin-bind-ip', default='0.0.0.0', help='NAS LAN interface address; default binds all interfaces')
parser.add_argument('--admin-port', type=int, default=8090)
parser.add_argument('--without-tunnel', action='store_true', help='Omit cloudflared for another transport')
args = parser.parse_args()
try: ipaddress.IPv4Address(args.admin_bind_ip)
except ValueError: parser.error('--admin-bind-ip must be an IPv4 address')
if not 1 <= args.admin_port <= 65535: parser.error('Invalid admin port')
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', args.image_tag): parser.error('Invalid image tag')
repo = Path(__file__).resolve().parent.parent
env = dict(os.environ, ADMIN_BIND_IP=args.admin_bind_ip, ADMIN_PORT=str(args.admin_port))
for variable, image in [('SYNC','sync'),('COMMANDER','desktop-commander'),('ADMIN','admin'),('TUNNEL','tunnel')]:
    env[f'OBSIDIAN_MCP_{variable}_IMAGE']=f'ghcr.io/glitchassassin/obsidian-mcp-{image}:{args.image_tag}'
command = ['docker', 'compose', '--env-file', '/dev/null', '-f', str(repo/'compose.yaml'), 'config']
if args.without_tunnel:
    result = subprocess.run(command+['--format','json'], env=env, check=True, capture_output=True, text=True)
    model = json.loads(result.stdout)
    del model['services']['cloudflared']
    model['services']['admin']['environment']['ADMIN_TUNNEL_REQUIRED'] = 'false'
    print(json.dumps(model, indent=2))
else: subprocess.run(command, env=env, check=True)
