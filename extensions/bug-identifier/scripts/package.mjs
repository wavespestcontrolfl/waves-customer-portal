// Builds the Chrome Web Store upload, dist/bug-identifier-<version>.zip,
// holding only the files the extension runs (no store/, scripts/, docs or
// the icon's SVG source). Bump "version" in manifest.json before each upload.
// Usage, from the repo root after `npm ci`:
//   node extensions/bug-identifier/scripts/package.mjs
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['manifest.json', 'background.js', 'panel.html', 'panel.css', 'panel.js'];
const DIRS = ['lib', 'content', 'icons'];

const { version } = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
await mkdir(join(EXT, 'dist'), { recursive: true });
const zipPath = join(EXT, 'dist', `bug-identifier-${version}.zip`);

const output = createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });
const written = new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
});
archive.pipe(output);
for (const file of FILES) archive.file(join(EXT, file), { name: file });
for (const dir of DIRS) archive.directory(join(EXT, dir), dir, (entry) => (entry.name.endsWith('.svg') ? false : entry));
await archive.finalize();
await written;
console.log(`wrote ${zipPath} (${archive.pointer()} bytes)`);
