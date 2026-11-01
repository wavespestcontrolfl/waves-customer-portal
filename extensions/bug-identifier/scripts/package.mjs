// Builds the store uploads, holding only the files the extension runs (no
// store/, scripts/, docs or the icon's SVG source). Bump "version" in
// manifest.json before each upload.
// Usage, from the repo root after `npm ci`:
//   node extensions/bug-identifier/scripts/package.mjs
//     Chrome Web Store and Edge Add-ons: dist/bug-identifier-<version>.zip
//   node extensions/bug-identifier/scripts/package.mjs --firefox
//     Firefox Add-ons: dist/bug-identifier-firefox-<version>.zip
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['background.js', 'panel.html', 'panel.css', 'panel.js'];
const DIRS = ['lib', 'content', 'icons'];
const FIREFOX = process.argv.includes('--firefox');

// Firefox runs no extension service workers and has no sidePanel API: its
// build runs background.js as an event page and declares panel.html as the
// sidebar, which background.js opens through browser.sidebarAction.
function firefoxManifest(manifest) {
  const out = { ...manifest, permissions: manifest.permissions.filter((p) => p !== 'sidePanel') };
  delete out.side_panel;
  delete out.minimum_chrome_version;
  out.background = { scripts: [manifest.background.service_worker], type: manifest.background.type };
  out.sidebar_action = {
    default_panel: manifest.side_panel.default_path,
    default_title: manifest.action.default_title,
    default_icon: manifest.action.default_icon,
    open_at_install: false,
  };
  out.browser_specific_settings = {
    gecko: {
      id: 'bug-identifier@wavespestcontrol.com',
      // 140 reads data_collection_permissions; captureVisibleTab under activeTab needs 126.
      strict_min_version: '140.0',
      // The photo the user picks, from a page or from their files, goes to the Waves API.
      data_collection_permissions: { required: ['websiteContent'] },
    },
  };
  return out;
}

const manifest = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
await mkdir(join(EXT, 'dist'), { recursive: true });
const zipPath = join(EXT, 'dist', `bug-identifier-${FIREFOX ? 'firefox-' : ''}${manifest.version}.zip`);

const output = createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });
const written = new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
});
archive.pipe(output);
if (FIREFOX) archive.append(`${JSON.stringify(firefoxManifest(manifest), null, 2)}\n`, { name: 'manifest.json' });
else archive.file(join(EXT, 'manifest.json'), { name: 'manifest.json' });
for (const file of FILES) archive.file(join(EXT, file), { name: file });
for (const dir of DIRS) archive.directory(join(EXT, dir), dir, (entry) => (entry.name.endsWith('.svg') ? false : entry));
await archive.finalize();
await written;
console.log(`wrote ${zipPath} (${archive.pointer()} bytes)`);
