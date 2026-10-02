#!/bin/sh
set -eu
umask 077
node /app/scripts/seed-commander.mjs
exec node /opt/supergateway/dist/index.js \
  --stdio "node /app/node_modules/@wonderwhy-er/desktop-commander/dist/index.js" \
  --outputTransport streamableHttp --stateful --sessionTimeout 600000 \
  --host 0.0.0.0 --port 8000 --streamableHttpPath /mcp \
  --healthEndpoint /healthz --logLevel info
