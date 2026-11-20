// A real Vite build of a part with its own stylesheet, with and without the
// plugin, then the preload helper that build ships, run on a stand-in page.
// With the plugin, an import that lists a stylesheet still loading waits for
// it and fails with it, and the next import after a failure loads it again.
// Vite alone skips a stylesheet it already started, and the part loads
// without it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { patchStylesheetPreload, stylesheetRetryPlugin } from './stylesheetRetry';

const dirs = [];

async function buildPart(plugins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylesheet-retry-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'entry.js'), "export const loadPart = () => import('./part.js');\n");
  fs.writeFileSync(path.join(dir, 'part.js'), "import './part.css';\nexport default 'part';\n");
  fs.writeFileSync(path.join(dir, 'part.css'), '.part { color: teal; }\n');
  await build({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins,
    build: {
      outDir: path.join(dir, 'dist'),
      minify: false,
      rollupOptions: {
        input: path.join(dir, 'entry.js'),
        preserveEntrySignatures: 'exports-only',
        output: { entryFileNames: 'entry.js' },
      },
    },
  });
  return pathToFileURL(path.join(dir, 'dist', 'entry.js')).href;
}

// The built entry's loader, from a copy of the entry of its own: the helper's
// record of what it loaded lives in the entry, and each test starts with none.
let copies = 0;
async function freshLoader(entry) {
  copies += 1;
  return (await import(`${entry}?copy=${copies}`)).loadPart;
}

// The page as the helper uses it: <link> elements in the head, each firing
// load or error when the test says.
function standInPage() {
  const links = [];
  globalThis.window = { dispatchEvent: () => true };
  globalThis.document = {
    head: { appendChild: (link) => links.push(link) },
    getElementsByTagName: () => links,
    querySelector(selector) {
      const match = /^link\[href="([^"]+)"\](\[rel="stylesheet"\])?$/.exec(selector);
      return links.find((link) => match && link.href === match[1] && (!match[2] || link.rel === 'stylesheet')) ?? null;
    },
    createElement() {
      const listeners = {};
      const link = {
        setAttribute() {},
        addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); },
        fire: (type) => (listeners[type] ?? []).forEach((listener) => listener()),
        remove: () => links.splice(links.indexOf(link), 1),
      };
      return link;
    },
  };
  return () => links.filter((link) => link.rel === 'stylesheet');
}

// Whether the promise settled by the time a short wait ends: an import that
// does not wait for the stylesheet settles within it.
async function settledSoon(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  return settled;
}

let pluginEntry;
let viteEntry;
let withPlugin;
let viteAlone;
beforeAll(async () => {
  pluginEntry = await buildPart([stylesheetRetryPlugin()]);
  viteEntry = await buildPart([]);
}, 60000);
beforeEach(async () => {
  withPlugin = await freshLoader(pluginEntry);
  viteAlone = await freshLoader(viteEntry);
});
afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});
afterAll(() => {
  dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

test('with the plugin, the next import loads a stylesheet that failed again, and fails while it is still missing', async () => {
  const stylesheets = standInPage();
  const first = withPlugin();
  expect(stylesheets()).toHaveLength(1);
  stylesheets()[0].fire('error');
  await expect(first).rejects.toThrow(/^Unable to preload CSS for \/assets\/part-.+\.css$/);
  expect(stylesheets()).toHaveLength(0);
  const second = withPlugin();
  expect(stylesheets()).toHaveLength(1);
  stylesheets()[0].fire('error');
  await expect(second).rejects.toThrow('Unable to preload CSS');
  const third = withPlugin();
  stylesheets()[0].fire('load');
  await expect(third).resolves.toMatchObject({ default: 'part' });
});

test('with the plugin, an import that lists a stylesheet still loading waits for it: it fails with it, or loads once it loads', async () => {
  const stylesheets = standInPage();
  const first = withPlugin();
  const second = withPlugin();
  expect(stylesheets()).toHaveLength(1);
  expect(await settledSoon(second)).toBe(false);
  stylesheets()[0].fire('error');
  await expect(first).rejects.toThrow('Unable to preload CSS');
  await expect(second).rejects.toThrow('Unable to preload CSS');
  const third = withPlugin();
  const fourth = withPlugin();
  expect(await settledSoon(fourth)).toBe(false);
  stylesheets()[0].fire('load');
  await expect(third).resolves.toMatchObject({ default: 'part' });
  await expect(fourth).resolves.toMatchObject({ default: 'part' });
  await expect(withPlugin()).resolves.toMatchObject({ default: 'part' });
  expect(stylesheets()).toHaveLength(1);
});

test('Vite alone skips a stylesheet that failed at the next import, and the part loads without it', async () => {
  const stylesheets = standInPage();
  const first = viteAlone();
  stylesheets()[0].fire('error');
  await expect(first).rejects.toThrow('Unable to preload CSS');
  const second = viteAlone();
  expect(stylesheets()).toHaveLength(1);
  await expect(second).resolves.toMatchObject({ default: 'part' });
});

test('Vite alone lets an import skip a stylesheet still loading: it loads without it, and only the first import fails', async () => {
  const stylesheets = standInPage();
  const first = viteAlone();
  const second = viteAlone();
  await expect(second).resolves.toMatchObject({ default: 'part' });
  stylesheets()[0].fire('error');
  await expect(first).rejects.toThrow('Unable to preload CSS');
});

test('the client build uses the plugin', async () => {
  const { default: config } = await import('../../vite.config.js');
  expect(config.plugins.flat().map((plugin) => plugin?.name)).toContain('waves-stylesheet-retry');
});

test('the build stops when the helper no longer has each line the plugin patches, or ships without it', () => {
  expect(() => patchStylesheetPreload('const seen = {};')).toThrow("Vite's preload helper changed");
  const plugin = stylesheetRetryPlugin();
  const context = { error: (message) => { throw new Error(message); } };
  const bundle = { 'assets/index.js': { type: 'chunk', code: 'new Error(`Unable to preload CSS for ${dep}`)' } };
  expect(() => plugin.generateBundle.call(context, {}, bundle)).toThrow("Vite's preload helper changed");
});
