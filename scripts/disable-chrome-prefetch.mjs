// Local patch for the pinned 0.2.52 package: avoid downloading a browser when
// an MCP client connects. PDF generation retains its upstream on-demand path.
import { readFileSync, writeFileSync } from 'node:fs';

const path = '/app/node_modules/@wonderwhy-er/desktop-commander/dist/index.js';
const source = readFileSync(path, 'utf8');
const statement = '            ensureChromeAvailable();';
if (source.split(statement).length !== 2) {
  throw new Error('Desktop Commander Chrome-prefetch patch no longer matches exactly once');
}
writeFileSync(path, source.replace(statement, '            // bootlace: skip automatic Chrome download on MCP initialization.'));
