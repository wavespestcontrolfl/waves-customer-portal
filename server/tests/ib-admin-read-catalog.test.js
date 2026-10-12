/**
 * The Intelligence Bar's admin read catalog (owner ruling 2026-10-12) is
 * generated from the admin request census. These tests keep it from
 * drifting from the census silently and keep anything that is not a plain
 * JSON data read out of it.
 */
const fs = require('fs');
const path = require('path');
const {
  buildCatalog, serialize, routerRoutes, judgeRoute, OUT_FILE, EXCLUSIONS_FILE, CENSUS_FILE,
} = require('../../scripts/build-ib-admin-read-catalog');
const rules = require('../utils/admin-read-rules');

const committed = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
const census = JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));

jest.setTimeout(60000);

test('regenerating the catalog gives the committed file byte for byte', () => {
  const { output } = buildCatalog();
  expect(serialize(output)).toBe(fs.readFileSync(OUT_FILE, 'utf8'));
});

test('every entry is a GET endpoint the census resolved, with named parameters', () => {
  const censusGets = new Set(census.actions
    .filter(a => a.operation.method === 'GET' && a.operation.resolution === 'literal_or_template')
    .map(a => a.operation.endpoint));
  expect(committed.entries.length).toBeGreaterThan(100);
  for (const entry of committed.entries) {
    const asCensus = `/${rules.splitPath(entry.endpoint).map(s => (rules.isParam(s) ? ':param' : s)).join('/')}`;
    expect({ endpoint: entry.endpoint, inCensus: censusGets.has(asCensus) }).toEqual({ endpoint: entry.endpoint, inCensus: true });
    expect(entry.params).toEqual(rules.patternParams(entry.endpoint));
    expect(new Set(entry.params).size).toBe(entry.params.length);
    expect(entry.label).toEqual(expect.any(String));
    expect(entry.screens.length).toBeGreaterThan(0);
  }
  expect(new Set(committed.entries.map(e => e.endpoint)).size).toBe(committed.entries.length);
});

test('no entry matches a deny rule', () => {
  const FORBIDDEN = /(^|\/|-|_)(auth|oauth|login|logout|mfa|password|passwords|credential|credentials|secret|secrets|token|tokens|callback|webhook|webhooks|session|sessions|export|download|csv|pdf|xlsx|zip|stream|sse|subscribe|events|gates|jwt)(\/|-|_|\.|$)/i;
  for (const entry of committed.entries) {
    expect({ endpoint: entry.endpoint, reason: rules.denyReason(entry.endpoint) }).toEqual({ endpoint: entry.endpoint, reason: null });
    expect({ endpoint: entry.endpoint, forbidden: FORBIDDEN.test(entry.endpoint) }).toEqual({ endpoint: entry.endpoint, forbidden: false });
    expect(entry.endpoint).not.toMatch(/\/admin\/(intelligence-bar|auth|credentials|feature-flags)(\/|$)/);
    expect(entry.endpoint).not.toMatch(/\.[a-z0-9]{1,6}$/i);
  }
});

test('the deny rules refuse each reviewed class of path', () => {
  const denied = [
    '/admin/auth/me', '/admin/credentials', '/admin/login', '/admin/change-password', '/admin/email/oauth/status',
    '/admin/kb/tokens/status', '/admin/x/webhook', '/admin/x/api-key', '/admin/x/sessions',
    '/admin/banking/export', '/admin/x/:id/download', '/admin/x/:id/pdf', '/admin/newsletter/subscribers.csv',
    '/admin/x/stream', '/admin/x/events', '/admin/x/subscribe', '/admin/feature-flags', '/admin/gates/state',
    '/admin/ads/sync', '/admin/x/:id/refresh', '/admin/x/run', '/admin/x/trigger', '/admin/x/generate',
    '/admin/x/recompute', '/admin/x/mark', '/admin/x/send', '/admin/intelligence-bar/threads',
    '/admin/x/../auth/me', '/admin/x//y', '/admin/x?y=1', '/api/admin/x', '/customers',
  ];
  for (const path of denied) expect({ path, reason: rules.denyReason(path) }).toEqual({ path, reason: expect.any(String) });
  for (const path of ['/admin/customers', '/admin/customers/:id/timeline', '/admin/schedule/week', '/admin/dashboard/funnel']) {
    expect({ path, reason: rules.denyReason(path) }).toEqual({ path, reason: null });
  }
});

test('the reviewed exclusion list gives a reason for every row', () => {
  const file = JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8'));
  expect(file.exclude.length + file.allow.length).toBeGreaterThan(0);
  for (const row of [...file.exclude, ...file.allow]) {
    expect(row.route).toMatch(/^GET \/admin\//);
    expect(typeof row.reason).toBe('string');
    expect(row.reason.trim().length).toBeGreaterThan(10);
  }
  // An allow row names the signals AND the unresolved callees it was read against.
  for (const row of file.allow) {
    expect(Array.isArray(row.signals) && Array.isArray(row.unresolved) && row.unresolved.length + row.signals.length > 0).toBe(true);
  }
  // A route the reviewer excluded never appears in the catalog.
  const excludedKeys = new Set(file.exclude.map(row => row.route.replace(/^GET /, '')));
  for (const entry of committed.entries) {
    const key = `/${rules.splitPath(entry.endpoint).map(s => (rules.isParam(s) ? ':param' : s)).join('/')}`;
    expect(excludedKeys.has(key)).toBe(false);
  }
});

test('the counts in the file add up and the blocked routes are admin paths', () => {
  const { counts } = committed;
  expect(counts.in_catalog).toBe(committed.entries.length);
  expect(counts.census_get_endpoints).toBeGreaterThanOrEqual(counts.in_catalog + counts.excluded_by_rule + counts.excluded_by_review);
  for (const route of committed.blockedRoutes) expect(route).toMatch(/^\/admin\//);
});

test('the endpoints that returned signed links or ran writes through a service are not in the catalog', () => {
  const endpoints = new Set(committed.entries.map(e => e.endpoint));
  expect(endpoints.has('/admin/call-recordings/calls/:id/intelligence')).toBe(false);
  expect(endpoints.has('/admin/inventory/restock-requests/:id/order-evidence')).toBe(false);
  expect(endpoints.has('/admin/turf-height/review')).toBe(false);
  expect(endpoints.has('/admin/communications/log')).toBe(false);
});

// ── the scan fails closed ────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ROOT, 'node_modules/.cache/ib-admin-read-fixture');
const FILES = {
  'fx-db.js': 'module.exports = () => ({ where() { return this; }, first: async () => ({}), update: async () => 1 });\n',
  'fx-svc-writes.js': `const db = require('./fx-db');
async function loadThing(id) {
  await db('things').where({ id }).update({ seen: true });
  return db('things').where({ id }).first();
}
module.exports = { loadThing };
`,
  'fx-router.js': `const express = require('express');
const db = require('./fx-db');
const vendor = require('fx-external-package');
const { getSignedUrl } = require('fx-external-presigner');
const router = express.Router();
router.get('/clean', async (req, res) => { res.json(await db('things').where({ id: req.query.id }).first()); });
router.get('/inline-writes', async (req, res) => { const { loadThing } = require('./fx-svc-writes'); res.json(await loadThing(req.query.id)); });
router.get('/chained-writes', async (req, res) => { res.json(await require('./fx-svc-writes').loadThing(req.query.id)); });
router.get('/unresolved', async (req, res) => { res.json(await vendor.lookup(req.query.id)); });
router.get('/signed', async (req, res) => { res.json({ url: await getSignedUrl(req.client, req.command) }); });
module.exports = router;
`,
};
const NO_REVIEW = { exclude: new Map(), allow: new Map() };

describe('the handler scan fails closed', () => {
  let routes;
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(FIXTURE_DIR, name), text);
    routes = routerRoutes(path.join(FIXTURE_DIR, 'fx-router.js')).routes;
  });
  afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

  const judge = (routePath, exclusions = NO_REVIEW) => judgeRoute({ full: `/admin/fx${routePath}`, route: routes.find(r => r.path === routePath) }, exclusions, []);
  const allow = (routePath, row) => ({ exclude: new Map(), allow: new Map([[`GET /admin/fx${routePath}`, { route: `GET /admin/fx${routePath}`, reason: 'fixture review', ...row }]]) });

  test('a handler that only reads through the query builder is admitted', () => {
    expect(judge('/clean')).toMatchObject({ safe: true, signals: [], unresolved: [] });
  });

  test('a handler whose imported service writes is excluded, whether it requires inside the handler or chains the require', () => {
    for (const routePath of ['/inline-writes', '/chained-writes']) {
      expect(judge(routePath)).toMatchObject({ safe: false, signals: expect.arrayContaining(['write:update']) });
    }
  });

  test('a write found in a service cannot be cleared by an allow row that names no signals', () => {
    const verdict = judge('/inline-writes', allow('/inline-writes', { signals: [], unresolved: [] }));
    expect(verdict.safe).toBe(false);
  });

  test('a handler with an unresolvable call is excluded without an allow row and admitted with a matching one', () => {
    const bare = judge('/unresolved');
    expect(bare.safe).toBe(false);
    expect(bare.unresolved).toHaveLength(1);
    expect(bare.unresolved[0]).toMatch(/fx-router\.js#vendor\.lookup$/);
    expect(bare.reason).toMatch(/unresolved:/);
    const reviewed = judge('/unresolved', allow('/unresolved', { signals: bare.signals, unresolved: bare.unresolved }));
    expect(reviewed).toMatchObject({ safe: true, cleared: 'fixture review' });
  });

  test('an allow row stops clearing the route when the callee list or the signals change', () => {
    const bare = judge('/unresolved');
    expect(judge('/unresolved', allow('/unresolved', { signals: bare.signals, unresolved: [...bare.unresolved, 'x.js#other'] })).safe).toBe(false);
    expect(judge('/unresolved', allow('/unresolved', { signals: bare.signals, unresolved: [] })).safe).toBe(false);
    expect(judge('/unresolved', allow('/unresolved', { signals: ['write:insert'], unresolved: bare.unresolved })).safe).toBe(false);
    expect(judge('/unresolved', allow('/unresolved', { signals: bare.signals })).safe).toBe(false);
  });

  test('a handler that mints a signed link is excluded and no allow row clears it', () => {
    const bare = judge('/signed');
    expect(bare.safe).toBe(false);
    expect(bare.signals).toEqual(expect.arrayContaining(['signed_url:getSignedUrl']));
    expect(judge('/signed', allow('/signed', { signals: bare.signals, unresolved: bare.unresolved })).safe).toBe(false);
  });
});
