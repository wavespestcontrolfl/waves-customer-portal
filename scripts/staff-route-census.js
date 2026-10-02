#!/usr/bin/env node
// Staff route census: renders the technician allow-list
// (server/middleware/technician-scope.js) against every mounted staff route and
// writes docs/technician-reachable-routes.md. `--check` exits 1 when the
// committed file is stale, so a review always sees the reach a change grants.
//
// Static, read-only: parses server/index.js for app.use('<mount>', <router>)
// and each router file for router.<method>('<path>', ...). "Today" reach is an
// approximation (router-wide or per-route requireAdmin); inline techRole
// branches inside handlers are not modelled, so a route marked reachable today
// may already self-scope. The "after flip" column is exact: it is the same
// matcher the middleware runs.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'server', 'index.js');
const ROUTES = path.join(ROOT, 'server', 'routes');
const OUT = path.join(ROOT, 'docs', 'technician-reachable-routes.md');
const { technicianMayReach, TECHNICIAN_ALLOW_LIST } = require('../server/middleware/technician-scope');

// Core staff mounts: every route counts. Mixed mounts (customer + staff
// routers, or a staff router under a public prefix): only routes that run
// adminAuthenticate (directly, via the router, or via an authStack) count.
const STAFF_PREFIX = /^\/api\/(admin|tech|dispatch|knowledge|ai)(\/|$)/;
const MIXED_MOUNTS = new Set(['/api', '/api/stripe/terminal', '/api/service/records', '/api/badges']);

function readIndexMounts() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const vars = new Map();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/routes\/([\w-]+)'\)/g)) vars.set(m[1], m[2]);
  const mounts = [];
  const re = /app\.use\(\s*'([^']+)'\s*,([^;]*?)\);/gs;
  for (const m of src.matchAll(re)) {
    const mount = m[1];
    if (!STAFF_PREFIX.test(mount) && !MIXED_MOUNTS.has(mount)) continue;
    const expr = m[2];
    const files = new Set();
    for (const r of expr.matchAll(/require\('\.\/routes\/([\w-]+)'\)(\.(\w+))?/g)) files.add(r[3] ? `${r[1]}#${r[3]}` : r[1]);
    for (const v of expr.matchAll(/\b(\w+)\b/g)) if (vars.has(v[1])) files.add(vars.get(v[1]));
    for (const f of files) mounts.push({ mount, file: f });
  }
  return mounts;
}

function parseRouter(fileSpec) {
  const [file, exportName] = fileSpec.split('#');
  const p = path.join(ROUTES, `${file}.js`);
  if (!fs.existsSync(p)) return { routes: [], adminWide: false, missing: true };
  const src = fs.readFileSync(p, 'utf8');
  // Router-wide guards: router.use(adminAuthenticate, requireAdmin) etc. A
  // file exporting several routers (serviceRouter/propertyRouter) is read as
  // one; its own guards are per-route in practice.
  const adminWide = /\brouter\.use\([^)]*\brequireAdmin\b[^)]*\)/.test(src);
  const routerStaffAuth = /\brouter\.use\([^)]*\badminAuthenticate\b[^)]*\)/.test(src);
  const routes = [];
  const re = /\b(router|serviceRouter|propertyRouter)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\3\s*,([^]*?)(?=\n(?:[a-zA-Z/]|\s*\}\);|\s*$))/g;
  for (const m of src.matchAll(re)) {
    const routerVar = m[1];
    if (exportName && routerVar !== exportName && routerVar !== 'router') continue;
    const method = m[2].toUpperCase();
    const routePath = m[4];
    const head = m[5].split('\n').slice(0, 6).join('\n');
    const guards = head.split('async')[0];
    const perRouteAdmin = /\brequireAdmin\b/.test(guards);
    const staffAuth = routerStaffAuth || /\b(adminAuthenticate|authStack)\b/.test(guards);
    routes.push({ method: method === 'ALL' ? 'GET' : method, routePath, perRouteAdmin, staffAuth });
  }
  return { routes, adminWide, missing: false };
}

function joinPath(mount, routePath) {
  const base = mount.replace(/\/+$/, '');
  const rest = routePath === '/' ? '' : routePath.replace(/^\/?/, '/');
  return `${base}${rest}` || '/';
}

// Replace :params with a representative value so the regexes see a real path.
function samplePath(p) {
  return p.replace(/:([a-zA-Z_]+)\??/g, (_, name) => (/sid|Sid/.test(name) ? 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '11111111-2222-4333-8444-555555555555'))
    .replace(/\*/g, 'x').replace(/\([^)]*\)\??/g, '');
}

function census() {
  const rows = [];
  for (const { mount, file } of readIndexMounts()) {
    const r = parseRouter(file);
    if (r.missing) continue;
    for (const route of r.routes) {
      if (MIXED_MOUNTS.has(mount) && !route.staffAuth) continue;
      const full = joinPath(mount, route.routePath);
      const today = !(r.adminWide || route.perRouteAdmin);
      const after = today && technicianMayReach(route.method, samplePath(full));
      rows.push({ method: route.method, path: full, file, today, after });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const k = `${row.method} ${row.path} ${row.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function render(rows) {
  const allowed = rows.filter((r) => r.after);
  const newlyDenied = rows.filter((r) => r.today && !r.after);
  const alreadyAdmin = rows.filter((r) => !r.today);
  const line = (r) => `| ${r.method} | \`${r.path}\` | ${r.file} |`;
  const table = (list) => ['| Method | Path | Router |', '|---|---|---|', ...list.map(line)].join('\n');
  return [
    '# Technician-reachable staff routes',
    '',
    'Generated by `node scripts/staff-route-census.js` from `server/middleware/technician-scope.js` and `server/index.js`. Do not edit by hand; the gates CI job fails when this file is stale.',
    '',
    'Owner ruling 2026-10-02: a technician-role login reaches only its own schedule and visits, own timesheet and mileage, texts with customers on its own visits, promises and proposals, protocols, documents, pay and growth, the knowledge base read-only, and equipment/inventory read-only. Everything else is admin-only.',
    '',
    `With GATE_STAFF_DEFAULT_DENY on, a technician reaches the ${allowed.length} routes in the first table. The ${newlyDenied.length} routes in the second table are open to a technician today and close at the flip. The ${alreadyAdmin.length} routes in the third table are admin-only already.`,
    '',
    'A route being listed as reachable means a technician may call it; routers still scope records to the assigned technician where they did before (schedule, customers, visits, timetracking).',
    '',
    `Allow-list buckets: ${[...new Set(TECHNICIAN_ALLOW_LIST.map((e) => e.bucket))].join(', ')}.`,
    '',
    '## Reachable by a technician after the flip',
    '',
    table(allowed),
    '',
    '## Open today, closed at the flip',
    '',
    table(newlyDenied),
    '',
    '## Admin-only already (unchanged)',
    '',
    table(alreadyAdmin),
    '',
  ].join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const rows = census();
  const md = render(rows);
  const counts = { allowed: rows.filter((r) => r.after).length, newlyDenied: rows.filter((r) => r.today && !r.after).length, adminOnly: rows.filter((r) => !r.today).length };
  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== md) {
      console.error(`technician-routes: docs/technician-reachable-routes.md is stale — run \`node scripts/staff-route-census.js\` and commit the result (${counts.allowed} reachable, ${counts.newlyDenied} newly denied, ${counts.adminOnly} admin-only).`);
      process.exit(1);
    }
    console.log(`technician-routes: up to date (${counts.allowed} reachable, ${counts.newlyDenied} newly denied, ${counts.adminOnly} admin-only).`);
    return;
  }
  fs.writeFileSync(OUT, md);
  console.log(`technician-routes: wrote ${path.relative(ROOT, OUT)} (${counts.allowed} reachable, ${counts.newlyDenied} newly denied, ${counts.adminOnly} admin-only).`);
}

if (require.main === module) main();
module.exports = { census, render, readIndexMounts, parseRouter };
