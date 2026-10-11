import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist');
// Explicitly include only browser assets and public snapshots. Scripts, tests,
// source documentation, and GitHub configuration are never published.
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'core.mjs',
  'public/data/prices.json',
  'public/data/stations.json',
];

// Check all inputs before removing the previous build.
await Promise.all(files.map(file => access(join(root, file))));
for (const file of files.filter(file => file.endsWith('.json'))) {
  const snapshot = JSON.parse(await readFile(join(root, file), 'utf8'));
  if (!Array.isArray(snapshot.stations)) {
    throw new Error(`${file} must contain a stations array`);
  }
}
await rm(output, { recursive: true, force: true });
for (const file of files) {
  const destination = join(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, file), destination);
}
await writeFile(join(output, '.nojekyll'), '');
console.log(`Built ${files.length} browser files and .nojekyll in dist/`);
