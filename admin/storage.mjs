import {mkdir, readFile, rename, writeFile, chmod} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomBytes} from 'node:crypto';

export async function privateDirectory(path) {
  await mkdir(path, {recursive: true, mode: 0o700});
  await chmod(path, 0o700);
}
export async function atomicWrite(path, contents) {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.tmp-${randomBytes(12).toString('hex')}`);
  await writeFile(temporary, contents, {mode: 0o600, flag: 'wx'});
  await rename(temporary, path);
}
export async function readOptional(path) {
  try {return await readFile(path, 'utf8');}
  catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
