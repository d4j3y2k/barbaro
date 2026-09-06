import { createHash } from 'node:crypto';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'barbaro' || typeof manifest.version !== 'string') throw new Error('Expected Barbaro package');
const outputRoot = resolve(root, 'dist/src');
const files = {};
async function walk(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.isSymbolicLink()) throw new Error('Build output must not contain symlinks');
    const path = join(directory, entry.name);
    const key = prefix + entry.name;
    if (entry.isDirectory()) await walk(path, key + '/');
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      files[key] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
}
await walk(outputRoot);
if (!files['cli.js']) throw new Error('Compiled CLI missing');
await chmod(join(outputRoot, 'cli.js'), 0o755);
await writeFile(join(outputRoot, 'build-identity.json'), JSON.stringify({
  schema: 'barbaro.build.v1', package_version: manifest.version, files,
}) + '\n');
