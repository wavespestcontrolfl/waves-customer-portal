// Every part of a page loads its code through lazyPanel (LazyPanel.jsx), and
// every route's page through App.jsx's lazyWithRetry. On a staff tab that
// open or held work keeps after a deploy, a part whose code is gone then
// shows its Reload prompt; a plain React.lazy would throw to the boundary
// around the whole route tree and unmount the staff layout, the Ask Waves
// draft included. This test fails on a plain React.lazy anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const SRC = path.resolve(process.cwd(), 'src');
const ALLOWED = new Set(['App.jsx', 'components/LazyPanel.jsx']);
const LAZY_CALL = /(?:\bReact\.lazy|(?<![\w.$])lazy)\s*\(/;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    if (!/\.(jsx?|tsx?)$/.test(entry.name) || /\.test\.|\.spec\./.test(entry.name)) return [];
    return [full];
  });
}

test('no client code loads a part of a page with a plain React.lazy', () => {
  const offenders = sourceFiles(SRC)
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => LAZY_CALL.test(fs.readFileSync(path.join(SRC, rel), 'utf8')));
  expect(offenders).toEqual([]);
});

test('App.jsx calls React.lazy only inside lazyWithRetry', () => {
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  const calls = app.match(/(?:\bReact\.lazy|(?<![\w.$])lazy)\s*\(/g) ?? [];
  expect(calls).toHaveLength(1);
  expect(app).toMatch(/export function lazyWithRetry\(factory\) \{\n {2}return lazy\(/);
});

// The page-use watcher notes each use for the whole page load, so it starts
// before React mounts, as the preload handler does: a use before a part's
// code fails must count. Each is a top-level statement of main.jsx.
test('main.jsx installs the page-use watcher and the preload handler before React mounts', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8');
  const mount = main.search(/^ReactDOM\.createRoot\(/m);
  const watcher = main.search(/^watchPageUse\(\);$/m);
  const handler = main.search(/^window\.addEventListener\('vite:preloadError'/m);
  expect(mount).toBeGreaterThan(-1);
  expect(watcher).toBeGreaterThan(-1);
  expect(handler).toBeGreaterThan(-1);
  expect(watcher).toBeLessThan(mount);
  expect(handler).toBeLessThan(mount);
});
