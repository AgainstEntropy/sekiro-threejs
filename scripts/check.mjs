import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(filename) : /\.[cm]?js$/.test(entry.name) ? [filename] : [];
  }));
  return groups.flat();
}

const files = (await Promise.all(['src', 'sandbox', 'scripts'].map((name) => collect(path.join(root, name))))).flat().sort();
let failures = 0;
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures++;
    console.error(path.relative(root, filename), result.error?.message || result.stderr);
  }
}
console.log(`Syntax check: ${files.length} files, ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
