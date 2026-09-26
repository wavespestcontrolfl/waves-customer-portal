/**
 * Every admin-app link the server builds (bell `link`, dashboard `href`,
 * server-rendered anchors) must name a page the admin router mounts.
 * The /admin catch-all silently redirects an unknown path to the
 * dashboard, so a dead link never errors — it just strands staff there
 * (`/admin/services`, `/admin/mileage` and 129 `/admin/customers/:id`
 * bells all did). Checks the first path segment against the child routes
 * declared under <Route path="/admin"> in client/src/App.jsx.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const SKIP_DIRS = new Set(['tests', '__tests__', 'node_modules', 'migrations']);

function adminRouteSegments() {
  const app = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
  const start = app.indexOf('<Route path="/admin"');
  const end = app.indexOf('\n          </Route>', start);
  if (start < 0 || end < 0) throw new Error('admin route block not found in App.jsx');
  const block = app.slice(start, end);
  // `path="…"` also matches Route declarations split across lines.
  return new Set([...block.matchAll(/\bpath="([^"/][^"]*)"/g)].map((m) => m[1].split('/')[0]));
}

function serverSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverSources(full, out);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

// Quoted admin paths that are not navigation targets: Express route
// declarations on sub-routers and API route-cache keys.
const NOT_A_LINK = /\b(router|app)\.(get|post|put|patch|delete|use|all)\(|clearRouteCacheForRequest/;

test('every server-built /admin link targets a mounted admin page', () => {
  const segments = adminRouteSegments();
  expect(segments.has('customers')).toBe(true); // parser sanity
  expect(segments.has('kb')).toBe(true); // multi-line <Route> declaration
  const dead = [];
  for (const file of serverSources(SERVER)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || NOT_A_LINK.test(code)) return;
      for (const m of code.matchAll(/[`'"]\/admin\/([a-z0-9-]+)/g)) {
        if (!segments.has(m[1])) dead.push(`${path.relative(ROOT, file)}:${i + 1} /admin/${m[1]}`);
      }
    });
  }
  expect(dead).toEqual([]);
});
