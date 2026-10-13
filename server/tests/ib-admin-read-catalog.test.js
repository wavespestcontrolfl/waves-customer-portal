/**
 * The Intelligence Bar's admin read catalog (owner ruling 2026-10-12) is
 * generated from the admin request census. These tests keep it from
 * drifting from the census silently and keep anything that is not a plain
 * JSON data read out of it.
 */
const fs = require('fs');
const path = require('path');
const {
  buildCatalog, serialize, routerRoutes, judgeRoute, endpointFingerprint, checkReview, resetCaches, loadReviewed, OUT_FILE, REVIEWED_FILE, CENSUS_FILE,
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
  expect(committed.entries.length).toBeGreaterThan(20);
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

const normalize = endpoint => `/${rules.splitPath(endpoint).map(seg => (rules.isParam(seg) ? ':param' : seg)).join('/')}`;

test('every reviewed row says what was read and carries the fingerprint it was reviewed against', () => {
  const file = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8'));
  expect(file.reviewed.length).toBeGreaterThan(20);
  const seen = new Set();
  for (const row of file.reviewed) {
    expect(row.endpoint).toMatch(/^\/admin\//);
    expect(seen.has(normalize(row.endpoint))).toBe(false);
    seen.add(normalize(row.endpoint));
    expect(typeof row.reviewed).toBe('string');
    expect(row.reviewed.trim().length).toBeGreaterThan(30);
    expect(row.reviewed).toMatch(/read end to end/);
    expect(Array.isArray(row.signals)).toBe(true);
    expect(Array.isArray(row.unresolved)).toBe(true);
    expect(row.hash).toMatch(/^[0-9a-f]{32}$/);
  }
  for (const row of file.exclude) {
    expect(row.route).toMatch(/^GET \/admin\//);
    expect(row.reason.trim().length).toBeGreaterThan(10);
  }
});

test('the committed catalog is exactly the reviewed list minus what the scan or a changed chain drops', () => {
  const reviewed = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8')).reviewed.map(row => normalize(row.endpoint));
  const inCatalog = committed.entries.map(entry => normalize(entry.endpoint));
  // Nothing is in the catalog without a reviewed row.
  expect(inCatalog.filter(endpoint => !reviewed.includes(endpoint))).toEqual([]);
  // Every reviewed row is in the catalog today (none is stale or scan-blocked).
  expect(reviewed.filter(endpoint => !inCatalog.includes(endpoint))).toEqual([]);
});

test('an endpoint with a clean scan and no reviewed row is not in the catalog; with a matching row it is', () => {
  const some = committed.entries[0].endpoint;
  const key = normalize(some);
  const full = loadReviewed();
  const row = full.reviewed.get(`GET ${key}`);
  expect(row).toBeDefined();
  const without = new Map(full.reviewed);
  without.delete(`GET ${key}`);
  const bare = buildCatalog({ reviewed: { exclude: full.exclude, reviewed: without } }).output;
  expect(bare.entries.map(entry => entry.endpoint)).not.toContain(some);
  expect(bare.entries).toHaveLength(committed.entries.length - 1);
  const stale = new Map(full.reviewed).set(`GET ${key}`, { ...row, hash: '0'.repeat(32) });
  const afterEdit = buildCatalog({ reviewed: { exclude: full.exclude, reviewed: stale } }).output;
  expect(afterEdit.entries.map(entry => entry.endpoint)).not.toContain(some);
});

test('a reviewed row whose unresolved list or signals no longer match drops the endpoint', () => {
  const full = loadReviewed();
  const some = committed.entries[0].endpoint;
  const key = `GET ${normalize(some)}`;
  const row = full.reviewed.get(key);
  for (const change of [{ unresolved: ['x.js#other'] }, { signals: ['effect_call:run'] }]) {
    const reviewed = new Map(full.reviewed).set(key, { ...row, ...change });
    const out = buildCatalog({ reviewed: { exclude: full.exclude, reviewed } }).output;
    expect(out.entries.map(entry => entry.endpoint)).not.toContain(some);
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
  'fx-callbacks.js': `const db = require('./fx-db');
async function markSeen(row) { await db('things').where({ id: row.id }).update({ seen: true }); return row; }
module.exports = { markSeen };
`,
};
FILES['fx-router-mw.js'] = `const express = require('express');
const db = require('./fx-db');
const router = express.Router();
router.get('/before', async (req, res) => { res.json(await db('things').where({ id: req.query.id }).first()); });
router.use(async (req, res, next) => { await db.raw('CREATE TABLE IF NOT EXISTS fx_boot (id int)'); next(); });
router.get('/after', async (req, res) => { res.json(await db('things').where({ id: req.query.id }).first()); });
module.exports = router;
`;
FILES['fx-router-scoped.js'] = `const express = require('express');
const db = require('./fx-db');
const router = express.Router();
router.use('/scoped', async (req, res, next) => { await db('things').update({ seen: true }); next(); });
router.get('/scoped/inside', async (req, res) => { res.json(await db('things').where({ id: req.query.id }).first()); });
router.get('/elsewhere', async (req, res) => { res.json(await db('things').where({ id: req.query.id }).first()); });
module.exports = router;
`;
FILES['fx-router-cred.js'] = `const express = require('express');
const db = require('./fx-db');
const router = express.Router();
router.get('/column-select', async (req, res) => { res.json(await db('things').select('things.id', 'estimates.token')); });
router.get('/whole-row', async (req, res) => { res.json(await db('newsletter_subscribers').where({ status: 'active' }).limit(5)); });
router.get('/aggregate', async (req, res) => { res.json(await db('newsletter_subscribers').count('* as n').first()); });
router.get('/explicit', async (req, res) => { res.json(await db('newsletter_subscribers').select('id', 'email').limit(3)); });
router.get('/link', async (req, res) => { res.json({ link: payUrl(req.query.id) }); });
router.get('/sql', async (req, res) => { res.json(await db.raw('select * from newsletter_subscribers limit 5')); });
module.exports = router;
`;
const NO_REVIEW = { exclude: new Map(), reviewed: new Map() };


describe('the handler scan and the reviewed row', () => {
  let routes;
  const writeFixtures = () => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(FIXTURE_DIR, name), text);
    resetCaches();
  };
  beforeAll(() => {
    FILES['fx-router-callbacks.js'] = `const express = require('express');
const db = require('./fx-db');
const vendor = require('fx-external-package');
const { markSeen } = require('./fx-callbacks');
const router = express.Router();
async function stampRow(row) { await db('things').where({ id: row.id }).update({ seen: true }); return row; }
router.get('/local-fn', async (req, res) => { const rows = await db('things').where({ id: req.query.id }); res.json(rows.map(stampRow)); });
router.get('/imported-fn', async (req, res) => { const rows = await db('things').where({ id: req.query.id }); res.json(await Promise.all(rows.map(markSeen))); });
router.get('/promise-fn', async (req, res) => { res.json(await db('things').where({ id: req.query.id }).first().then(markSeen)); });
router.get('/unresolved-fn', async (req, res) => { const rows = await db('things').where({ id: req.query.id }); res.json(rows.map(vendor.decorate)); });
router.get('/safe-fns', async (req, res) => { const rows = await db('things').where({ id: req.query.id }); res.json(rows.map(Number).filter(Boolean)); });
module.exports = router;
`;
    writeFixtures();
    routes = routerRoutes(path.join(FIXTURE_DIR, 'fx-router.js')).routes;
  });
  afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

  const judgeIn = (file, routePath) => {
    const found = routerRoutes(path.join(FIXTURE_DIR, file)).routes.find(r => r.path === routePath);
    return judgeRoute({ full: `/admin/fx${routePath}`, route: found }, NO_REVIEW, []);
  };
  const judge = routePath => judgeRoute({ full: `/admin/fx${routePath}`, route: routes.find(r => r.path === routePath) }, NO_REVIEW, []);
  const rowFor = (verdict, extra = {}) => ({ endpoint: '/admin/fx/x', reviewed: 'fixture review, read end to end', ...endpointFingerprint([verdict]), ...extra });

  test('a handler that only reads through the query builder passes the scan and carries a fingerprint', () => {
    const verdict = judge('/clean');
    expect(verdict).toMatchObject({ safe: true, signals: [], unresolved: [] });
    expect(verdict.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(checkReview(endpointFingerprint([verdict]), rowFor(verdict))).toBeNull();
    expect(checkReview(endpointFingerprint([verdict]), undefined)).toBe('not reviewed');
  });

  test('a handler whose imported service writes is excluded, whether it requires inside the handler or chains the require', () => {
    for (const routePath of ['/inline-writes', '/chained-writes']) {
      expect(judge(routePath)).toMatchObject({ safe: false, signals: expect.arrayContaining(['write:update']) });
    }
  });

  test('a reviewed row cannot admit a route whose scan reports a write, an outside call, DDL, a link or a credential', () => {
    const cases = [['fx-router.js', '/inline-writes'], ['fx-router.js', '/signed'], ['fx-router-mw.js', '/after'],
      ['fx-router-cred.js', '/column-select'], ['fx-router-cred.js', '/whole-row'], ['fx-router-cred.js', '/link']];
    for (const [file, routePath] of cases) {
      const found = routerRoutes(path.join(FIXTURE_DIR, file)).routes.find(r => r.path === routePath);
      const entry = { full: `/admin/fx${routePath}`, route: found };
      const bare = judgeRoute(entry, NO_REVIEW, []);
      const row = rowFor(bare);
      const reviewed = { exclude: new Map(), reviewed: new Map([[`GET /admin/fx${routePath}`, row]]) };
      expect({ routePath, safe: judgeRoute(entry, reviewed, []).safe }).toEqual({ routePath, safe: false });
    }
  });

  test('a handler with an unresolvable call is not admitted until a row names exactly those callees', () => {
    const bare = judge('/unresolved');
    expect(bare.safe).toBe(true); // the scan lock passes; admission is the row
    expect(bare.unresolved).toHaveLength(1);
    expect(bare.unresolved[0]).toMatch(/fx-router\.js#vendor\.lookup$/);
    const fingerprint = endpointFingerprint([bare]);
    expect(checkReview(fingerprint, undefined)).toBe('not reviewed');
    expect(checkReview(fingerprint, rowFor(bare))).toBeNull();
    expect(checkReview(fingerprint, rowFor(bare, { unresolved: [] }))).toMatch(/unresolved callees changed/);
    expect(checkReview(fingerprint, rowFor(bare, { unresolved: [...bare.unresolved, 'x.js#other'] }))).toMatch(/unresolved callees changed/);
    expect(checkReview(fingerprint, rowFor(bare, { signals: ['effect_call:run'] }))).toMatch(/signals changed/);
  });

  test('a writing named callback is flagged, whether local, imported or passed to then', () => {
    for (const routePath of ['/local-fn', '/imported-fn', '/promise-fn']) {
      const verdict = judgeIn('fx-router-callbacks.js', routePath);
      expect({ routePath, safe: verdict.safe, signals: verdict.signals }).toEqual({ routePath, safe: false, signals: expect.arrayContaining(['write:update']) });
    }
  });

  test('a named callback that cannot be resolved is an unresolved callee, and built-in callbacks are not', () => {
    const unresolved = judgeIn('fx-router-callbacks.js', '/unresolved-fn');
    expect(unresolved.unresolved.join(' ')).toMatch(/callback vendor\.decorate/);
    expect(judgeIn('fx-router-callbacks.js', '/safe-fns')).toMatchObject({ safe: true, unresolved: [] });
  });

  test('any edit inside the handler chain, even in a helper only, changes the hash and drops a reviewed row', () => {
    const helperPath = path.join(FIXTURE_DIR, 'fx-helper.js');
    const routerText = `const express = require('express');
const db = require('./fx-db');
const router = express.Router();
router.get('/helped', async (req, res) => { const { shape } = require('./fx-helper'); res.json(shape(await db('things').where({ id: req.query.id }).first())); });
module.exports = router;
`;
    fs.writeFileSync(path.join(FIXTURE_DIR, 'fx-router-helped.js'), routerText);
    fs.writeFileSync(helperPath, 'function shape(row) { return { id: row && row.id }; }\nmodule.exports = { shape };\n');
    resetCaches();
    const before = judgeIn('fx-router-helped.js', '/helped');
    expect(before).toMatchObject({ safe: true, signals: [], unresolved: [] });
    const row = rowFor(before);
    expect(checkReview(endpointFingerprint([before]), row)).toBeNull();
    fs.writeFileSync(helperPath, 'function shape(row) { return { id: row && row.id, again: 1 }; }\nmodule.exports = { shape };\n');
    resetCaches();
    const after = judgeIn('fx-router-helped.js', '/helped');
    expect(after.hash).not.toBe(before.hash);
    expect(checkReview(endpointFingerprint([after]), row)).toMatch(/handler chain changed/);
    writeFixtures();
  });

  test('router.use middleware that runs DDL excludes every route declared after it, not the ones before', () => {
    expect(judgeIn('fx-router-mw.js', '/before')).toMatchObject({ safe: true });
    const after = judgeIn('fx-router-mw.js', '/after');
    expect(after.safe).toBe(false);
    expect(after.signals).toEqual(expect.arrayContaining(['write:sql_text']));
  });

  test('a path-scoped router.use applies only to its sub-path', () => {
    const inside = judgeIn('fx-router-scoped.js', '/scoped/inside');
    expect(inside.safe).toBe(false);
    expect(inside.signals).toEqual(expect.arrayContaining(['write:update']));
    expect(judgeIn('fx-router-scoped.js', '/elsewhere')).toMatchObject({ safe: true });
  });

  test('a handler that selects a credential column, reads whole rows of a table that has one, or builds a token link is excluded', () => {
    expect(judgeIn('fx-router-cred.js', '/column-select').signals).toEqual(expect.arrayContaining(['credential_field:estimates.token']));
    expect(judgeIn('fx-router-cred.js', '/whole-row').signals).toEqual(['credential_table:newsletter_subscribers']);
    expect(judgeIn('fx-router-cred.js', '/sql').signals).toEqual(expect.arrayContaining(['credential_table:newsletter_subscribers']));
    expect(judgeIn('fx-router-cred.js', '/link').signals).toEqual(expect.arrayContaining(['credential_link:payUrl']));
  });

  test('an aggregate or an explicit column list on the same table is not a credential read', () => {
    expect(judgeIn('fx-router-cred.js', '/aggregate')).toMatchObject({ safe: true });
    expect(judgeIn('fx-router-cred.js', '/explicit')).toMatchObject({ safe: true });
  });
});

test('the endpoints that run middleware DDL or return credentials are not in the catalog', () => {
  const endpoints = committed.entries.map(e => e.endpoint);
  expect(endpoints.filter(e => /^\/admin\/(health|equipment-maintenance)(\/|$)/.test(e))).toEqual([]);
  expect(endpoints).not.toContain('/admin/customers/:id/estimates-summary');
  expect(endpoints).not.toContain('/admin/newsletter/subscribers');
});
