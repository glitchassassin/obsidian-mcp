#!/usr/bin/env python3
"""Retag and publish locally loaded images only after the runtime tests passed."""
import os, re, subprocess

sha=os.environ['GITHUB_SHA']
if not re.fullmatch(r'[0-9a-f]{40}',sha): raise SystemExit('Invalid source revision')
owner=os.environ['GITHUB_REPOSITORY_OWNER'].lower()
tags=[f'sha-{sha}']
if os.environ['GITHUB_REF']=='refs/heads/main': tags.append('latest')
elif os.environ['GITHUB_REF'].startswith('refs/tags/v'):
    version=os.environ['GITHUB_REF_NAME']
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',version): raise SystemExit('Invalid release tag')
    tags.append(version)
for local,name in [(os.environ['OBSIDIAN_MCP_SYNC_IMAGE'],'obsidian-mcp-sync'),
                   (os.environ['OBSIDIAN_MCP_COMMANDER_IMAGE'],'obsidian-mcp-desktop-commander'),
                   (os.environ['OBSIDIAN_MCP_ADMIN_IMAGE'],'obsidian-mcp-admin'),
                   (os.environ['OBSIDIAN_MCP_TUNNEL_IMAGE'],'obsidian-mcp-tunnel')]:
    image=f'ghcr.io/{owner}/{name}'
    for tag in tags:
        reference=f'{image}:{tag}'
        subprocess.run(['docker','tag',local,reference],check=True)
        subprocess.run(['docker','push',reference],check=True)
    if summary:=os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(summary,'a') as output:
            output.write(f'- Published `{image}:sha-{sha}` (tested linux/amd64 image).\n')
