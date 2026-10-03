#!/usr/bin/env bash
# Only disposable fixtures. Does not contact Obsidian or Cloudflare.
set -euo pipefail
: "${OBSIDIAN_MCP_SYNC_IMAGE:?Set the locally built Sync image}"
: "${OBSIDIAN_MCP_COMMANDER_IMAGE:?Set the locally built Commander image}"
: "${OBSIDIAN_MCP_ADMIN_IMAGE:?Set the locally built Admin image}"
: "${OBSIDIAN_MCP_TUNNEL_IMAGE:?Set the locally built Tunnel image}"
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export ADMIN_BIND_IP=127.0.0.1 ADMIN_PORT=0
project="obsidian-mcp-ci-$RANDOM-$$"
compose=(docker compose --env-file /dev/null -f "$repo_dir/compose.yaml" -p "$project")
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs --tail 60 || true; fi
  "${compose[@]}" down --volumes --remove-orphans || true
  exit "$result"
}
trap cleanup EXIT
# Unit/API tests run against an injected provider, never a real account.
docker run --rm --entrypoint node -v "$repo_dir/tests:/app/tests:ro" "$OBSIDIAN_MCP_ADMIN_IMAGE" --test /app/tests/admin.test.mjs
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 90
"${compose[@]}" exec -T sync ob --version
"${compose[@]}" exec -T cloudflared cloudflared --version
"${compose[@]}" exec -T sync node -e 'const DB=require("/app/node_modules/better-sqlite3"); const db=new DB(":memory:"); if(db.prepare("select 1 as result").get().result!==1)process.exit(1); db.close(); console.log("PASS: native SQLite",process.arch);'
"${compose[@]}" exec -T admin node --input-type=module -e '
import assert from "node:assert/strict";import fs from "node:fs";
const base="http://127.0.0.1:8090";
const initial=await (await fetch(base+"/api/status")).json();assert.deepEqual(initial,{passwordSet:false,authenticated:false});
const bootstrap=await fetch(base+"/api/password",{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({password:"synthetic-ci-admin-password"})});assert.equal(bootstrap.status,201);
const stored=fs.readFileSync("/admin-state/state.json","utf8");assert(!stored.includes("synthetic-ci-admin-password"));
for(const dir of ["/admin-state","/run/mcp-key","/run/tunnel-key","/home/node/.config"]){const s=fs.statSync(dir);assert.equal(s.uid,1000);assert.equal(s.gid,1000);assert.equal(s.mode&0o777,0o700);}
fs.writeFileSync("/run/mcp-key/token","synthetic-ci-mcp-key",{mode:0o600});fs.writeFileSync("/run/mcp-key/ready","ready",{mode:0o600});
fs.writeFileSync("/run/tunnel-key/token","synthetic-ci-tunnel-key",{mode:0o600}); // No ready marker: never connect to Cloudflare.
fs.mkdirSync("/home/node/.config/obsidian-headless",{recursive:true,mode:0o700});
fs.writeFileSync("/home/node/.config/obsidian-headless/auth_token","SYNTHETIC_SYNC_ONLY_SENTINEL",{mode:0o600}); // No Sync ready marker.
fs.writeFileSync("/vault/ci-volume-persistence.txt","SYNTHETIC_SHARED_VAULT");
console.log("PASS: admin bootstrap, private automatic volumes, and waiting services");'
"${compose[@]}" exec -T desktop-commander node --input-type=module -e '
for(let i=0;i<30;i++){try{if((await fetch("http://127.0.0.1:8000/healthz")).ok)process.exit(0);}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);'
"${compose[@]}" exec -T desktop-commander node /app/scripts/smoke-test.mjs
"${compose[@]}" exec -T desktop-commander node -e '
const fs=require("node:fs"),assert=require("node:assert/strict");
assert.equal(fs.readFileSync("/vault/ci-volume-persistence.txt","utf8"),"SYNTHETIC_SHARED_VAULT");
for(const p of ["/run/tunnel-key/token","/admin-state/state.json","/home/node/.config/obsidian-headless/auth_token"])assert(!fs.existsSync(p));
assert.throws(()=>fs.writeFileSync("/run/mcp-key/token","tamper"),/EROFS/);
const p="/home/node/.claude-server-commander/config.json",c=JSON.parse(fs.readFileSync(p));c.fileReadLineLimit=137;fs.writeFileSync(p,JSON.stringify(c));'
# Rotation must restart the gateway and revoke an old, already-open MCP session.
"${compose[@]}" exec -T desktop-commander node /app/scripts/rotation-test.mjs &
rotation_pid=$!
"${compose[@]}" exec -T admin node --input-type=module -e '
import fs from "node:fs/promises";
for(let i=0;i<30;i++){try{await fs.access("/vault/ci-rotation-ready");break;}catch{}if(i===29)process.exit(1);await new Promise(r=>setTimeout(r,500));}
await fs.writeFile("/run/mcp-key/replacement","synthetic-ci-replacement-key",{mode:0o600});await fs.rename("/run/mcp-key/replacement","/run/mcp-key/token");'
wait "$rotation_pid"
"${compose[@]}" exec -T cloudflared node --input-type=module -e '
import fs from "node:fs";import assert from "node:assert/strict";
assert.throws(()=>fs.writeFileSync("/run/tunnel-key/token","tamper"),/EROFS/);
for(const p of ["/run/mcp-key/token","/admin-state/state.json","/home/node/.config/obsidian-headless/auth_token"])assert(!fs.existsSync(p));
assert.equal((await (await fetch("http://127.0.0.1:8001/healthz")).json()).state,"waiting");
try{await fetch("http://admin:8090/healthz");assert.fail("Admin must not be on the tunnel network");}catch(error){assert(!String(error).includes("Admin must not"));}
console.log("PASS: tunnel token is read-only and admin service name is absent from the tunnel network");'
"${compose[@]}" down
"${compose[@]}" up -d --wait --wait-timeout 90
"${compose[@]}" exec -T desktop-commander node -e '
const fs=require("node:fs"),assert=require("node:assert/strict");
assert.equal(JSON.parse(fs.readFileSync("/home/node/.claude-server-commander/config.json")).fileReadLineLimit,137);
assert.equal(fs.readFileSync("/vault/ci-volume-persistence.txt","utf8"),"SYNTHETIC_SHARED_VAULT");
assert.equal(fs.readFileSync("/run/mcp-key/token","utf8"),"synthetic-ci-replacement-key");'
"${compose[@]}" exec -T admin node --input-type=module -e '
import fs from "node:fs";import assert from "node:assert/strict";
const base="http://127.0.0.1:8090";
assert.deepEqual(await (await fetch(base+"/api/status")).json(),{passwordSet:true,authenticated:false});
const response=await fetch(base+"/api/login",{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({password:"synthetic-ci-admin-password"})});assert.equal(response.status,200);
assert.equal(fs.readFileSync("/home/node/.config/obsidian-headless/auth_token","utf8"),"SYNTHETIC_SYNC_ONLY_SENTINEL");
console.log("PASS: admin password, vault, private credentials, and Commander state persist through recreation");'
"${compose[@]}" logs | python3 -c 'import sys; s=sys.stdin.read(); assert "Downloading Chrome" not in s; assert all(secret not in s for secret in ["synthetic-ci-admin-password","synthetic-ci-mcp-key","synthetic-ci-replacement-key","synthetic-ci-tunnel-key","SYNTHETIC_SYNC_ONLY_SENTINEL"])'
echo 'PASS: admin setup/security, automatic volumes, authentication and rotation, credential/network isolation, file/search/binary tools, and recreation persistence.'
