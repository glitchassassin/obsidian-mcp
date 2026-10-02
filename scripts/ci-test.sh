#!/usr/bin/env bash
# Only disposable fixtures. Does not contact Obsidian or Cloudflare.
set -euo pipefail
: "${OBSIDIAN_MCP_SYNC_IMAGE:?Set the locally built Sync image}"
: "${OBSIDIAN_MCP_COMMANDER_IMAGE:?Set the locally built Commander image}"
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/obsidian-mcp-ci.XXXXXX")"
export OBSIDIAN_MCP_AUTH_TOKEN_FILE="$fixture_dir/mcp-token"
export OBSIDIAN_MCP_TUNNEL_TOKEN_FILE="$fixture_dir/tunnel-token"
project="obsidian-mcp-ci-$RANDOM-$$"
compose=(docker compose --env-file /dev/null -f "$repo_dir/compose.yaml" -p "$project")
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs --tail 80 sync desktop-commander || true; fi
  "${compose[@]}" down --volumes --remove-orphans || true
  docker run --rm --user 0 --entrypoint python3 \
    -v "$fixture_dir:/fixture" "$OBSIDIAN_MCP_SYNC_IMAGE" -c \
    'import pathlib; [p.unlink() for p in pathlib.Path("/fixture").iterdir()]' || true
  rmdir "$fixture_dir" || true
  exit "$result"
}
trap cleanup EXIT
# Host files provide only synthetic secrets. Compose must create all data volumes.
docker run --rm --user 0 --entrypoint python3 \
  -v "$fixture_dir:/fixture" "$OBSIDIAN_MCP_SYNC_IMAGE" -c '
import os,pathlib
root=pathlib.Path("/fixture"); root.chmod(0o755)
for name,value,owner in [("mcp-token","synthetic-ci-mcp-key",1000),("tunnel-token","synthetic-ci-tunnel-key",0)]:
 p=root/name; p.write_text(value); os.chown(p,owner,owner); p.chmod(0o600)
'
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 90 sync desktop-commander
"${compose[@]}" exec -T sync ob --version
"${compose[@]}" exec -T sync node -e 'const DB=require("/app/node_modules/better-sqlite3"); const db=new DB(":memory:"); if(db.prepare("select 1 as result").get().result!==1)process.exit(1); db.close(); console.log("PASS: native SQLite",process.arch);'
"${compose[@]}" logs sync | python3 -c 'import sys; sys.exit(0 if "Waiting for vault setup" in sys.stdin.read() else 1)'
"${compose[@]}" exec -T sync node -e '
const fs=require("node:fs"),assert=require("node:assert/strict");
for(const p of ["/vault","/home/node/.config"]){const s=fs.statSync(p);assert.equal(s.uid,1000);assert.equal(s.gid,1000);}
assert.equal(fs.statSync("/home/node/.config").mode&0o777,0o700);
fs.mkdirSync("/home/node/.config/obsidian-headless",{recursive:true,mode:0o700});
fs.writeFileSync("/home/node/.config/obsidian-headless/auth_token","SYNTHETIC_SYNC_ONLY_SENTINEL",{mode:0o600});
fs.writeFileSync("/vault/ci-volume-persistence.txt","SYNTHETIC_SHARED_VAULT");
console.log("PASS: fresh named-volume ownership and private Sync state");'
"${compose[@]}" exec -T desktop-commander node /app/scripts/smoke-test.mjs
"${compose[@]}" exec -T desktop-commander node -e '
const fs=require("node:fs"),assert=require("node:assert/strict");
const state="/home/node/.claude-server-commander";assert.equal(fs.statSync(state).mode&0o777,0o700);
assert.equal(fs.readFileSync("/vault/ci-volume-persistence.txt","utf8"),"SYNTHETIC_SHARED_VAULT");
assert(!fs.existsSync("/run/secrets/tunnel-token"));
const p=state+"/config.json",c=JSON.parse(fs.readFileSync(p));c.fileReadLineLimit=137;fs.writeFileSync(p,JSON.stringify(c));'
# Container removal must preserve the automatically created data volumes.
"${compose[@]}" down
"${compose[@]}" up -d --wait --wait-timeout 90 sync desktop-commander
"${compose[@]}" exec -T desktop-commander node -e '
const fs=require("node:fs"),assert=require("node:assert/strict");
const c=JSON.parse(fs.readFileSync("/home/node/.claude-server-commander/config.json"));assert.equal(c.fileReadLineLimit,137);
assert.equal(fs.readFileSync("/vault/ci-volume-persistence.txt","utf8"),"SYNTHETIC_SHARED_VAULT");
console.log("PASS: vault and Commander configuration survive container recreation");'
"${compose[@]}" exec -T sync node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");assert.equal(fs.readFileSync("/home/node/.config/obsidian-headless/auth_token","utf8"),"SYNTHETIC_SYNC_ONLY_SENTINEL");console.log("PASS: private Sync state survives container recreation");'
"${compose[@]}" logs desktop-commander | python3 -c 'import sys; assert "Downloading Chrome" not in sys.stdin.read(), "Unexpected Chrome prefetch"'
echo 'PASS: automatic named volumes, file-backed secrets, authentication, credential isolation, file/search/binary tools, Sync waiting, and recreation persistence.'
