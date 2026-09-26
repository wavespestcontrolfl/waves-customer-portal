/**
 * Every admin-app link the server builds (bell `link`, dashboard `href`,
 * server-rendered anchors) must name a page the admin router mounts.
 * The /admin catch-all silently redirects an unknown path to the
 * dashboard, so a dead link never errors — it just strands staff there
 * (`/admin/services`, `/admin/mileage` and 129 `/admin/customers/:id`
 * bells all did). Each link's full path — query and hash ignored, a
 * template `${…}` standing in for one path segment — must match a route
 * declared in client/src/App.jsx: a child of <Route path="/admin"> or an
 * absolute /admin/* route (login and password pages).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const SKIP_DIRS = new Set(['tests', '__tests__', 'node_modules', 'migrations']);

function adminRoutePatterns() {
  const app = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
  const start = app.indexOf('<Route path="/admin"');
  const end = app.indexOf('\n          </Route>', start);
  if (start < 0 || end < 0) throw new Error('admin route block not found in App.jsx');
  // `path="…"` also matches Route declarations split across lines. Every
  // child route in the block is flat (self-closing), so a child's full path
  // is /admin/<path>. The "*" catch-all is the failure being guarded.
  const children = [...app.slice(start, end).matchAll(/\bpath="([^"/*][^"]*)"/g)].map((m) => m[1]);
  const absolute = [...app.matchAll(/\bpath="\/admin\/([^"]+)"/g)].map((m) => m[1]);
  return [...children, ...absolute].map((route) => ({
    route,
    re: new RegExp(`^${route.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`),
  }));
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
// declarations on sub-routers, API `endpoint`s the client posts to under
// /api, and API route-cache keys.
const NOT_A_LINK = /\b(router|app)\.(get|post|put|patch|delete|use|all)\(|\bendpoint\b|clearRouteCacheForRequest/;

// The path part of every quoted /admin link on a line: `${…}` stands in for
// one segment, and a string ending in "/" (`'/admin/x/' + id`) is followed
// by one concatenated segment.
function adminLinkPaths(line) {
  let code = line;
  for (let i = 0; i < 3; i += 1) code = code.replace(/\$\{[^{}]*\}/g, 'X');
  return [...code.matchAll(/[`'"](?:X|https?:\/\/[^/\s`'"]+)?\/admin\/([^`'"\s]*)/g)]
    .map((m) => m[1].split(/[?#]/)[0].replace(/\/+$/, (tail) => (m[1].includes('?') || m[1].includes('#') ? '' : `${tail.slice(0, 1)}X`)))
    .filter(Boolean);
}

test('link paths resolve the way the router does', () => {
  expect(adminLinkPaths("link: `/admin/customers?customerId=${svc.customer_id}`,")).toEqual(['customers']);
  expect(adminLinkPaths('link: `/admin/customers/${svc.customer_id}`,')).toEqual(['customers/X']);
  expect(adminLinkPaths("href: '/admin/estimates/' + id")).toEqual(['estimates/X']);
  expect(adminLinkPaths("link: '/admin/leads?view=all/'")).toEqual(['leads']);
  const patterns = adminRoutePatterns();
  const mounted = (p) => patterns.some(({ re }) => re.test(p));
  expect(mounted('customers')).toBe(true);
  expect(mounted('kb')).toBe(true); // multi-line <Route> declaration
  expect(mounted('estimates/X/proposal')).toBe(true); // :param segment
  expect(mounted('login')).toBe(true); // absolute /admin/login route
  expect(mounted('services')).toBe(false);
  expect(mounted('customers/X/stage')).toBe(false);
});

test('every server-built /admin link targets a mounted admin page', () => {
  const patterns = adminRoutePatterns();
  const dead = [];
  for (const file of serverSources(SERVER)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trim();
      if (/^(\/\/|\/\*|\*)/.test(code) || NOT_A_LINK.test(code)) return;
      // A glob ('/admin/*' in the app-links exclusions) is a pattern, not a link.
      for (const linkPath of adminLinkPaths(code).filter((p) => !p.includes('*'))) {
        if (!patterns.some(({ re }) => re.test(linkPath))) dead.push(`${path.relative(ROOT, file)}:${i + 1} /admin/${linkPath}`);
      }
    });
  }
  expect(dead).toEqual([]);
});
