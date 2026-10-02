#!/usr/bin/env bash
# Only disposable fixtures. Does not contact Obsidian or Cloudflare.
set -euo pipefail
: "${OBSIDIAN_MCP_SYNC_IMAGE:?Set the locally built Sync image}"
: "${OBSIDIAN_MCP_COMMANDER_IMAGE:?Set the locally built Commander image}"
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/obsidian-mcp-ci.XXXXXX")"
export OBSIDIAN_MCP_DATA_DIR="$fixture_dir"
project="obsidian-mcp-ci-$RANDOM-$$"
compose=(docker compose --env-file /dev/null -f "$repo_dir/compose.yaml" -p "$project")
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs --tail 80 sync desktop-commander || true; fi
  "${compose[@]}" down --volumes --remove-orphans || true
  docker run --rm --user 0 --entrypoint python3 \
    -v "$fixture_dir:/fixture" "$OBSIDIAN_MCP_SYNC_IMAGE" -c \
    'import pathlib,shutil; [shutil.rmtree(p) if p.is_dir() else p.unlink() for p in pathlib.Path("/fixture").iterdir()]' || true
  rmdir "$fixture_dir" || true
  exit "$result"
}
trap cleanup EXIT
docker run --rm --user 0 --entrypoint python3 \
  -v "$fixture_dir:/fixture" "$OBSIDIAN_MCP_SYNC_IMAGE" -c '
import os,pathlib
root=pathlib.Path("/fixture")
os.chmod(root,0o755)
for name in ["vault","sync-config","commander-state","secrets","sync-config/obsidian-headless"]:
 p=root/name; p.mkdir(exist_ok=True); os.chown(p,1000,1000); p.chmod(0o700)
for name,value in [("secrets/mcp-token","synthetic-ci-mcp-key"),("sync-config/obsidian-headless/auth_token","SYNTHETIC_SYNC_ONLY_SENTINEL")]:
 p=root/name; p.write_text(value); os.chown(p,1000,1000); p.chmod(0o600)
'
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 90 sync desktop-commander
"${compose[@]}" exec -T sync ob --version
"${compose[@]}" exec -T sync node -e 'const DB=require("/app/node_modules/better-sqlite3"); const db=new DB(":memory:"); if(db.prepare("select 1 as result").get().result!==1)process.exit(1); db.close(); console.log("PASS: native SQLite",process.arch);'
"${compose[@]}" logs sync | python3 -c 'import sys; sys.exit(0 if "Waiting for vault setup" in sys.stdin.read() else 1)'
"${compose[@]}" exec -T desktop-commander node /app/scripts/smoke-test.mjs
"${compose[@]}" exec -T desktop-commander node -e 'const fs=require("node:fs"); const p="/home/node/.claude-server-commander/config.json"; const c=JSON.parse(fs.readFileSync(p)); c.fileReadLineLimit=137; fs.writeFileSync(p,JSON.stringify(c));'
"${compose[@]}" restart desktop-commander
"${compose[@]}" up -d --wait --wait-timeout 90 sync desktop-commander
"${compose[@]}" exec -T desktop-commander node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync("/home/node/.claude-server-commander/config.json")); if(c.fileReadLineLimit!==137)process.exit(1); console.log("PASS: config seeding preserves existing state after restart");'
"${compose[@]}" logs desktop-commander | python3 -c 'import sys; assert "Downloading Chrome" not in sys.stdin.read(), "Unexpected Chrome prefetch"'
echo 'PASS: production bind mounts, key-file auth, credential isolation, file/search/binary tools, Sync waiting, and restart persistence.'
