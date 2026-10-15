import { mkdir, copyFile, cp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'assets'), { recursive: true });
// Explicit deployment allowlist: research, source data, revisions and Git remain private.
for (const name of ['index.html', 'app.js', 'scan-surface.js', 'camera-preview.js', 'sites.js', 'sites.css', 'style.css']) {
  await copyFile(resolve(root, name), resolve(dist, name));
}
for (const name of await readdir(resolve(root, 'assets'))) {
  if (/\.(png|f32|json)$/.test(name)) await copyFile(resolve(root, 'assets', name), resolve(dist, 'assets', name));
}
await cp(resolve(root, 'vendor'), resolve(dist, 'vendor'), { recursive: true });
console.log('Built public preview assets in dist/');
