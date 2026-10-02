// Persistent state mounts may start empty. Seed once; preserve user configuration.
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';

const directory = '/home/node/.claude-server-commander';
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  await copyFile('/app/config/commander.json', `${directory}/config.json`, constants.COPYFILE_EXCL);
  await chmod(`${directory}/config.json`, 0o600);
  console.log('Initialized Desktop Commander configuration.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
