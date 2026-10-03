// The OS sees only this fixed script path. Secrets remain in stdin and memory.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {input += data; if (input.length > 16384) process.exit(1);});
process.stdin.on('end', () => {
  const args = JSON.parse(input);
  if (!Array.isArray(args) || args[0] !== 'sync-setup' || args.some(arg => typeof arg !== 'string')) process.exit(1);
  process.argv = [process.execPath, '/app/node_modules/obsidian-headless/cli.js', ...args];
  require('/app/node_modules/obsidian-headless/cli.js');
});
