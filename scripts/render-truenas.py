#!/usr/bin/env python3
"""Render a fully resolved TrueNAS YAML without reading token file contents."""
import argparse, os, re, subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data-dir', required=True, help='Absolute NAS dataset path')
parser.add_argument('--image-tag', required=True, help='Published sha-<commit> or version tag')
parser.add_argument('--without-tunnel', action='store_true', help='Omit cloudflared for setup or another transport')
args = parser.parse_args()
if not Path(args.data_dir).is_absolute(): parser.error('--data-dir must be absolute')
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', args.image_tag): parser.error('Invalid image tag')
repo = Path(__file__).resolve().parent.parent
env = dict(os.environ,
    OBSIDIAN_MCP_DATA_DIR=args.data_dir,
    OBSIDIAN_MCP_SYNC_IMAGE=f'ghcr.io/glitchassassin/obsidian-mcp-sync:{args.image_tag}',
    OBSIDIAN_MCP_COMMANDER_IMAGE=f'ghcr.io/glitchassassin/obsidian-mcp-desktop-commander:{args.image_tag}')
command = ['docker', 'compose', '--env-file', '/dev/null', '-f', str(repo/'compose.yaml'), 'config']
if args.without_tunnel:
    # JSON is valid YAML and lets us remove only the connector without a YAML dependency.
    import json
    result = subprocess.run(command+['--format','json'], env=env, check=True, capture_output=True, text=True)
    model=json.loads(result.stdout)
    del model['services']['cloudflared']
    print(json.dumps(model,indent=2))
else:
    subprocess.run(command, env=env, check=True)
