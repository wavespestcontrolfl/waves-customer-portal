// A real Vite build of a part with its own stylesheet, with and without the
// plugin, then the preload helper that build ships, run on a stand-in page.
// With the plugin, an import that lists a stylesheet still loading waits for
// it and fails with it, and the next import after a failure loads it again,
// in the place of the failed link. Vite alone skips a stylesheet it already
// started, and the part loads without it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { patchStylesheetPreload, stylesheetRetryPlugin } from './stylesheetRetry';

const dirs = [];

// A part with its own stylesheet.
const PART = {
  'entry.js': "export const loadPart = () => import('./part.js');\n",
  'part.js': "import './part.css';\nexport default 'part';\n",
  'part.css': '.part { color: teal; }\n',
};
// A part that lists two stylesheets: a shared one, then its own, which sets
// the same rule. Another part imports the shared module too, so the build
// gives it a file of its own.
const PAIR = {
  'entry.js': "export const loadPart = () => import('./part.js');\nexport const loadOther = () => import('./other.js');\n",
  'part.js': "import { shared } from './shared.js';\nimport './part.css';\nexport default `part ${shared}`;\n",
  'other.js': "import { shared } from './shared.js';\nexport default `other ${shared}`;\n",
  'shared.js': "import './shared.css';\nexport const shared = 'shared';\n",
  'shared.css': '.card { color: gray; }\n',
  'part.css': '.card { color: teal; }\n',
};

async function buildPart(plugins, files = PART) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylesheet-retry-'));
  dirs.push(dir);
  Object.entries(files).forEach(([name, text]) => fs.writeFileSync(path.join(dir, name), text));
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

// The page as the helper uses it: <link> elements in the head, in order,
// each firing load or error when the test says. A selector names a link by
// its attributes, as the helper writes it: link[href="..."][rel="..."].
function standInPage() {
  const links = [];
  const find = (selector) => {
    const clauses = [...selector.matchAll(/\[(\w+)="([^"]*)"\]/g)];
    return links.find((link) => selector.startsWith('link[') && clauses.every(([, name, value]) => link[name] === value)) ?? null;
  };
  globalThis.window = { dispatchEvent: () => true };
  globalThis.document = {
    head: { appendChild: (link) => links.push(link), querySelector: find },
    getElementsByTagName: () => links,
    querySelector: find,
    createElement() {
      const listeners = {};
      const link = {
        setAttribute() {},
        addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); },
        fire: (type) => (listeners[type] ?? []).forEach((listener) => listener()),
        remove: () => links.splice(links.indexOf(link), 1),
        replaceWith: (other) => links.splice(links.indexOf(link), 1, other),
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
let pairEntry;
let withPlugin;
let viteAlone;
beforeAll(async () => {
  pluginEntry = await buildPart([stylesheetRetryPlugin()]);
  viteEntry = await buildPart([]);
  pairEntry = await buildPart([stylesheetRetryPlugin()], PAIR);
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

// The part's own stylesheet comes after the shared one and wins where both
// set a rule. When the shared one failed and the part's loaded, the next load
// of the shared one takes its old place, so the part's still comes after it.
test('with the plugin, a stylesheet that failed loads again in its place: a stylesheet listed after it stays after it', async () => {
  const stylesheets = standInPage();
  const loadPair = await freshLoader(pairEntry);
  const first = loadPair();
  const [shared, own] = stylesheets();
  expect(shared.href).toMatch(/^\/assets\/shared-.+\.css$/);
  expect(own.href).toMatch(/^\/assets\/part-.+\.css$/);
  shared.fire('error');
  own.fire('load');
  await expect(first).rejects.toThrow(`Unable to preload CSS for ${shared.href}`);
  const second = loadPair();
  const retried = stylesheets().find((link) => link !== own);
  retried.fire('load');
  await expect(second).resolves.toMatchObject({ default: 'part shared' });
  expect(stylesheets()).toEqual([retried, own]);
  expect(retried.href).toBe(shared.href);
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
