/**
 * The Intelligence Bar's admin read catalog (owner ruling 2026-10-12) is
 * generated from the admin request census. These tests keep it from
 * drifting from the census silently and keep anything that is not a plain
 * JSON data read out of it.
 */
const fs = require('fs');
const path = require('path');
const {
  buildCatalog, serialize, routeTable, routerRoutes, judgeRoute, validateReviewedRow, endpointFingerprint, checkReview, resetCaches, loadReviewed, OUT_FILE, REVIEWED_FILE, CENSUS_FILE,
} = require('../../scripts/build-ib-admin-read-catalog');
const rules = require('../utils/admin-read-rules');

const committed = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
const census = JSON.parse(fs.readFileSync(CENSUS_FILE, 'utf8'));

jest.setTimeout(60000);

const normalize = endpoint => `/${rules.splitPath(endpoint).map(seg => (rules.isParam(seg) ? ':param' : seg)).join('/')}`;

// The failure other lanes see when their change edits code a reviewed read
// depends on: in plain words, with the endpoints and the one command.
function catalogDriftMessage(excluded) {
  const reviewedKeys = new Set(Object.keys(JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8')).reviewed.reduce((acc, row) => ({ ...acc, [row.endpoint]: 1 }), {})));
  const stale = excluded.review.filter(item => /^review is stale/.test(item.reason)
    && [...reviewedKeys].some(endpoint => normalize(endpoint) === normalize(item.endpoint)));
  if (!stale.length) {
    return 'The Intelligence Bar read list (server/services/intelligence-bar/admin-read-catalog.json) is out of date. Run `npm run ib:read-catalog` and commit the result (server/services/intelligence-bar/README.md).';
  }
  return `A reviewed Intelligence Bar read went stale because its code changed: ${stale.map(item => `${item.endpoint} (${item.reason.replace(/^review is stale: /, '')})`).join('; ')}. `
    + 'Run `npm run ib:read-catalog` and commit the result: CI then passes, and the endpoint leaves the bar\'s read list until someone re-reviews it (server/services/intelligence-bar/README.md).';
}

test('regenerating the catalog gives the committed file byte for byte', () => {
  const { output, excluded } = buildCatalog();
  if (serialize(output) !== fs.readFileSync(OUT_FILE, 'utf8')) throw new Error(catalogDriftMessage(excluded));
});

test('the drift message names the stale endpoints, the reason and the one command', () => {
  const full = loadReviewed();
  const victim = committed.entries[0].endpoint;
  const key = `GET ${normalize(victim)}`;
  const stale = new Map(full.reviewed).set(key, { ...full.reviewed.get(key), hash: '0'.repeat(32) });
  const { output, excluded } = buildCatalog({ reviewed: { exclude: full.exclude, reviewed: stale } });
  expect(serialize(output)).not.toBe(fs.readFileSync(OUT_FILE, 'utf8'));
  const message = catalogDriftMessage(excluded);
  expect(message).toBe(`A reviewed Intelligence Bar read went stale because its code changed: ${victim} (the handler chain changed). `
    + 'Run `npm run ib:read-catalog` and commit the result: CI then passes, and the endpoint leaves the bar\'s read list until someone re-reviews it (server/services/intelligence-bar/README.md).');
});

test('the runtime reads the committed catalog only: a stale row cannot throw there', () => {
  const root = path.resolve(__dirname, '..', 'services', 'intelligence-bar');
  for (const file of ['admin-read-tools.js', 'task-context.js']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8').split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).not.toMatch(/admin-read-reviewed|build-ib-admin-read-catalog/);
  }
  expect(fs.readFileSync(path.join(root, 'admin-read-tools.js'), 'utf8')).toContain("require('./admin-read-catalog.json')");
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
    expect(['broad', 'customer', 'invoice']).toContain(row.scope);
    expect(() => validateReviewedRow(row)).not.toThrow();
    if (row.freeText !== undefined) expect(row.freeText.length).toBeGreaterThan(0);
  }
  for (const row of file.exclude) {
    expect(row.route).toMatch(/^GET \/admin\//);
    expect(row.reason.trim().length).toBeGreaterThan(10);
  }
});

describe('the scope of a reviewed row', () => {
  const base = { reviewed: 'fixture review, read end to end', signals: [], unresolved: [], hash: '0'.repeat(32) };
  // Every path parameter must declare a kind; the fixtures default to uuid.
  const kindsFor = endpoint => Object.fromEntries((endpoint.match(/:[A-Za-z]+/g) || []).map(name => [name.slice(1), 'uuid']));
  const validate = fixture => validateReviewedRow({ ...fixture, params: fixture.params === undefined ? kindsFor(fixture.endpoint) : fixture.params });
  const row = extra => ({ endpoint: '/admin/customers/:id/credits', ...base, ...extra });
  test('a pattern with a customer id parameter must be customer-scoped to that parameter', () => {
    expect(() => validate(row({ scope: 'customer', scopeParam: 'id' }))).not.toThrow();
    expect(() => validate(row({ scope: 'broad' }))).toThrow(/carries a customer id/);
    expect(() => validate(row({ scope: 'invoice', scopeParam: 'id' }))).toThrow(/carries a customer id/);
    expect(() => validate(row({ scope: 'customer', scopeParam: 'other' }))).toThrow(/carries a customer id/);
    expect(() => validate(row({}))).toThrow(/scope must be one of/);
    expect(() => validate({ ...row({ scope: 'customer', scopeParam: 'id' }), endpoint: '/admin/invoices/service-records/:customerId' })).toThrow(/carries a customer id/);
    expect(() => validate({ ...row({ scope: 'customer', scopeParam: 'customerId' }), endpoint: '/admin/invoices/service-records/:customerId' })).not.toThrow();
  });
  test('a pattern with an invoice id parameter must be invoice-scoped', () => {
    const invoice = extra => ({ ...row(extra), endpoint: '/admin/invoices/:id/credit-context' });
    expect(() => validate(invoice({ scope: 'invoice', scopeParam: 'id' }))).not.toThrow();
    expect(() => validate(invoice({ scope: 'broad' }))).toThrow(/carries an invoice id/);
    expect(() => validate(invoice({ scope: 'customer', scopeParam: 'id' }))).toThrow(/carries an invoice id/);
  });
  test('a broad row names no scope parameter; any other row must name one', () => {
    const plain = extra => ({ ...row(extra), endpoint: '/admin/payers' });
    expect(() => validate(plain({ scope: 'broad' }))).not.toThrow();
    expect(() => validate(plain({ scope: 'broad', scopeParam: 'id' }))).toThrow(/no scopeParam/);
    expect(() => validate(plain({ scope: 'customer' }))).toThrow(/scopeParam must name/);
    expect(() => validate(plain({ scope: 'customer', scopeParam: 'customerId', query: ['customerId'] }))).not.toThrow();
  });
  test('a param kind is uuid, int or text, names a parameter of the pattern, and every path parameter has one', () => {
    const named = extra => ({ ...row(extra), endpoint: '/admin/job-forms/templates/by-service/:serviceType', scope: 'broad' });
    expect(() => validate(named({ params: { serviceType: 'text' } }))).not.toThrow();
    expect(() => validate(named({ params: { serviceType: 'free' } }))).toThrow(/must be "uuid", "int" or "text"/);
    expect(() => validate(named({ params: { serviceType: 'text', other: 'text' } }))).toThrow(/must be "uuid", "int" or "text"/);
    expect(() => validate(named({ params: {} }))).toThrow(/params.serviceType is missing/);
    expect(() => validate(named({ params: { serviceType: 'int' } }))).not.toThrow();
    expect(() => validate(named({ params: ['serviceType'] }))).toThrow(/object of parameter kinds/);
    expect(() => validate({ ...row({ scope: 'customer', scopeParam: 'id', params: { id: 'text' } }) })).toThrow(/scope parameter must be "uuid"/);
    expect(() => validate({ ...row({ scope: 'customer', scopeParam: 'id', params: { id: 'int' } }) })).toThrow(/scope parameter must be "uuid"/);
  });
  test('a freeText list names response fields', () => {
    const plain = extra => ({ ...row(extra), endpoint: '/admin/payers', scope: 'broad' });
    expect(() => validate(plain({ freeText: ['notes'] }))).not.toThrow();
    expect(() => validate(plain({ freeText: 'notes' }))).toThrow(/freeText must be a list/);
    expect(() => validate(plain({ freeText: ['no tes'] }))).toThrow(/freeText must be a list/);
    const rows = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8')).reviewed;
    expect(rows.filter(r => r.freeText).length).toBeGreaterThan(5);
    for (const r of rows.filter(item => item.freeText)) expect(r.freeText.every(key => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))).toBe(true);
  });
  test('the build fails when a handler that reads a customer id from the query is reviewed as broad', () => {
    const full = loadReviewed();
    const key = 'GET /admin/schedule/next-visit';
    const wrong = new Map(full.reviewed).set(key, { ...full.reviewed.get(key), scope: 'broad', scopeParam: undefined });
    expect(() => buildCatalog({ reviewed: { exclude: full.exclude, reviewed: wrong } })).toThrow(/reads a customer id from the query string/);
  });
  test('a query list is a list of distinct key names, and a scope id read from the query must be in it', () => {
    const plain = extra => ({ ...row(extra), endpoint: '/admin/payers', scope: 'broad' });
    expect(() => validate(plain({ query: ['days', 'search'] }))).not.toThrow();
    expect(() => validate(plain({ query: 'days' }))).toThrow(/list of distinct key names/);
    expect(() => validate(plain({ query: ['days', 'days'] }))).toThrow(/list of distinct key names/);
    expect(() => validate(plain({ query: ['a b'] }))).toThrow(/list of distinct key names/);
    const nextVisit = extra => ({ ...row(extra), endpoint: '/admin/schedule/next-visit', scope: 'customer', scopeParam: 'customerId' });
    expect(() => validate(nextVisit({}))).toThrow(/query list must include it/);
    expect(() => validate(nextVisit({ query: ['customerId'] }))).not.toThrow();
  });
  test('the build fails when a row lists a query key the handler chain does not read', () => {
    const full = loadReviewed();
    const victim = committed.entries.find(entry => entry.query.length) || committed.entries[0];
    const key = `GET ${normalize(victim.endpoint)}`;
    const row = full.reviewed.get(key);
    const bad = new Map(full.reviewed).set(key, { ...row, query: [...(row.query || []), 'zzunseenkey'] });
    expect(() => buildCatalog({ reviewed: { exclude: full.exclude, reviewed: bad } })).toThrow(/query key\(s\) zzunseenkey not read by the handler chain/);
    const ok = new Map(full.reviewed).set(key, { ...row });
    expect(buildCatalog({ reviewed: { exclude: full.exclude, reviewed: ok } }).output.entries.find(entry => entry.endpoint === victim.endpoint).query).toEqual(victim.query);
  });
  test('a row with no query list forwards no query at all', () => {
    const rows = new Map(JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8')).reviewed.map(row => [row.endpoint, row]));
    for (const entry of committed.entries) expect({ endpoint: entry.endpoint, query: entry.query }).toEqual({ endpoint: entry.endpoint, query: rows.get(entry.endpoint).query || [] });
  });
  test('the build fails when a row does not use the catalog pattern', () => {
    const full = loadReviewed();
    const key = 'GET /admin/customers/:param/credits';
    const renamed = new Map(full.reviewed).set(key, { ...full.reviewed.get(key), endpoint: '/admin/customers/:customerId/credits', scopeParam: 'customerId' });
    expect(() => buildCatalog({ reviewed: { exclude: full.exclude, reviewed: renamed } })).toThrow(/must use the catalog pattern/);
  });
});

// The catalog's accounting against the reviewed rows: nothing is in the catalog
// without a row, and a row may be absent only when the generator reports it
// (stale or scan-failed) with a reason.
function catalogAccounting(entries, rows, excluded) {
  const reviewedKeys = rows.map(row => normalize(row.endpoint));
  const inCatalog = entries.map(entry => normalize(entry.endpoint));
  const reported = new Map(excluded.review.concat(excluded.rule).map(item => [normalize(item.endpoint), item.reason]));
  return {
    notReviewed: inCatalog.filter(endpoint => !reviewedKeys.includes(endpoint)),
    missingWithoutReason: reviewedKeys.filter(endpoint => !inCatalog.includes(endpoint) && !reported.get(endpoint)),
  };
}

test('the committed catalog is a subset of the reviewed rows, and every other row is reported by the generator with a reason', () => {
  const rows = JSON.parse(fs.readFileSync(REVIEWED_FILE, 'utf8')).reviewed;
  const { excluded } = buildCatalog();
  expect(catalogAccounting(committed.entries, rows, excluded)).toEqual({ notReviewed: [], missingWithoutReason: [] });
});

// The other-lane story, end to end: a PR edits a function a reviewed read
// follows. The byte-for-byte test fails with the plain message; running
// `npm run ib:read-catalog` and committing makes every check pass again with
// that endpoint out of the read list.
test('after a followed function changes, regenerating makes the suite green with the endpoint absent', () => {
  const full = loadReviewed();
  const victim = committed.entries[0].endpoint;
  const key = `GET ${normalize(victim)}`;
  const staleRows = new Map(full.reviewed).set(key, { ...full.reviewed.get(key), hash: '0'.repeat(32) });
  const staleReviewed = { exclude: full.exclude, reviewed: staleRows };

  // 1. The lane's PR leaves the committed file as it was: the byte test fails, in plain words.
  const first = buildCatalog({ reviewed: staleReviewed });
  expect(serialize(first.output)).not.toBe(fs.readFileSync(OUT_FILE, 'utf8'));
  expect(catalogDriftMessage(first.excluded)).toContain(`${victim} (the handler chain changed)`);

  // 2. `npm run ib:read-catalog`: the file is regenerated, the endpoint is out of the list.
  const regenerated = first.output;
  expect(regenerated.entries.map(entry => entry.endpoint)).not.toContain(victim);
  expect(regenerated.entries).toHaveLength(committed.entries.length - 1);

  // 3. With that file committed: the byte test passes (regeneration is stable) ...
  const again = buildCatalog({ reviewed: staleReviewed });
  expect(serialize(again.output)).toBe(serialize(regenerated));
  // ... the accounting passes (the absent row is reported with its reason) ...
  const rows = [...staleRows.values()];
  expect(catalogAccounting(regenerated.entries, rows, again.excluded)).toEqual({ notReviewed: [], missingWithoutReason: [] });
  expect(again.excluded.review.find(item => normalize(item.endpoint) === normalize(victim)).reason).toMatch(/^review is stale/);
  // ... and what the bar can read no longer includes it, whatever the tool tests assume.
  expect(regenerated.entries.every(entry => typeof entry.scope === 'string' && Array.isArray(entry.query))).toBe(true);
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

test('the committed file holds nothing that changes with unrelated routes: no counts, only version, source, entries, blockedRoutes', () => {
  expect(Object.keys(committed)).toEqual(['version', 'source', 'entries', 'blockedRoutes']);
  expect(JSON.stringify(committed)).not.toMatch(/census_get_endpoints|excluded_by|in_catalog|unresolvable_template/);
  for (const route of committed.blockedRoutes) expect(route).toMatch(/^\/admin\//);
});

test('the counts are printed by the generator, not committed', () => {
  const { counts, output } = buildCatalog();
  expect(counts).toMatchObject({ in_catalog: output.entries.length });
  expect(counts.census_get_endpoints).toBeGreaterThanOrEqual(counts.in_catalog + counts.excluded_by_rule);
  expect(Object.keys(output)).toEqual(['version', 'source', 'entries', 'blockedRoutes']);
});

test('an unrelated GET route that no reviewed row covers leaves the generated file byte-identical', () => {
  const base = serialize(buildCatalog().output);
  const real = routeTable();
  // A copy of a real, unreviewed route under a new path, and a census action that calls it.
  const donor = real.table.find(entry => /^\/admin\/[a-z-]+\/[a-z-]+$/.test(entry.full) && !committed.entries.some(item => item.endpoint === entry.full));
  const clone = { ...donor, full: '/admin/zz-unrelated-fixture/list' };
  const action = JSON.parse(JSON.stringify(census.actions.find(a => a.operation.method === 'GET' && a.operation.resolution === 'literal_or_template')));
  action.operation.endpoint = '/admin/zz-unrelated-fixture/list';
  const withExtra = buildCatalog({ census: { ...census, actions: [...census.actions, action] }, routes: { table: [...real.table, clone], opaqueMounts: real.opaqueMounts } });
  expect(withExtra.counts.census_get_endpoints).toBe(buildCatalog().counts.census_get_endpoints + 1);
  expect(serialize(withExtra.output)).toBe(base);
  // Also a census action for a route the backend does not have, and an unrelated route removed from the table.
  const ghost = JSON.parse(JSON.stringify(action));
  ghost.operation.endpoint = '/admin/zz-ghost/none';
  const fewer = real.table.filter(entry => entry !== donor);
  expect(serialize(buildCatalog({ census: { ...census, actions: [...census.actions, ghost] }, routes: { table: fewer, opaqueMounts: real.opaqueMounts } }).output)).toBe(base);
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
  'fx-router-query.js': `const express = require('express');
const db = require('./fx-db');
const router = express.Router();
router.get('/keys', async (req, res) => { const { alpha, beta: renamed = 1 } = req.query; const gamma = req.query.gamma; const q = req.query; res.json(await db('things').where({ id: alpha, b: renamed, g: gamma, d: req.query['delta'], e: q.epsilon }).first()); });
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

  test('the query keys a handler reads are collected: dot, bracket, destructuring and an alias', () => {
    expect(judgeIn('fx-router-query.js', '/keys').queryKeys).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
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

  describe('module-scope constants in the fingerprint', () => {
    const write = (name, text) => fs.writeFileSync(path.join(FIXTURE_DIR, name), text);
    // WINDOW -> BASE are same-file constants; IMPORTED comes from another file.
    const router = ({ base = 5, unused = 1 } = {}) => `const express = require('express');
const db = require('./fx-db');
const { IMPORTED } = require('./fx-consts');
const BASE = ${base};
const WINDOW = BASE * 2;
const UNUSED = ${unused};
const router = express.Router();
router.get('/windowed', async (req, res) => { const { days } = req.query; res.json(await db('things').where('d', '<', WINDOW + IMPORTED + Number(days || 0)).first()); });
module.exports = router;
`;
    const consts = (value = 3) => `const IMPORTED = ${value};\nmodule.exports = { IMPORTED };\n`;
    const hashFor = () => {
      resetCaches();
      return judgeIn('fx-router-consts.js', '/windowed');
    };
    beforeEach(() => { write('fx-router-consts.js', router()); write('fx-consts.js', consts()); });
    afterAll(() => writeFixtures());

    test('a same-file constant a followed function references is in the hash', () => {
      const before = hashFor();
      expect(before).toMatchObject({ safe: true, signals: [], unresolved: [] });
      expect(before.constants.join('\n')).toContain('WINDOW = BASE * 2');
    });

    test('an edit to the constant the handler names makes the review stale', () => {
      const before = hashFor();
      const row = rowFor(before);
      write('fx-router-consts.js', router().replace('BASE * 2', 'BASE * 3'));
      expect(checkReview(endpointFingerprint([hashFor()]), row)).toMatch(/handler chain changed/);
    });

    test('a constant the referenced constant uses (transitive, same file) makes the review stale', () => {
      const before = hashFor();
      const row = rowFor(before);
      write('fx-router-consts.js', router({ base: 6 }));
      const after = hashFor();
      expect(after.constants.join('\n')).toContain('BASE = 6');
      expect(checkReview(endpointFingerprint([after]), row)).toMatch(/handler chain changed/);
    });

    test('an unreferenced constant in the same file stays out of the hash and the row stays', () => {
      const before = hashFor();
      const row = rowFor(before);
      expect(before.constants.join('\n')).not.toContain('UNUSED');
      write('fx-router-consts.js', router({ unused: 99 }));
      const after = hashFor();
      expect(after.hash).toBe(before.hash);
      expect(checkReview(endpointFingerprint([after]), row)).toBeNull();
    });

    test('a constant in an imported file is not hashed: only the import statement is', () => {
      const before = hashFor();
      const row = rowFor(before);
      expect(before.constants.join('\n')).toContain("{ IMPORTED } = require('./fx-consts')");
      write('fx-consts.js', consts(4000));
      const after = hashFor();
      expect(after.hash).toBe(before.hash);
      expect(checkReview(endpointFingerprint([after]), row)).toBeNull();
    });

    test('editing a file under server/config/ does not stale a row, editing a same-file constant does', () => {
      const dir = path.join(FIXTURE_DIR, 'server', 'config');
      fs.mkdirSync(dir, { recursive: true });
      const gates = value => `const GATES = { fast: ${value} };\nfunction gateOn() { return GATES.fast === true; }\nmodule.exports = { gateOn, GATES };\n`;
      fs.writeFileSync(path.join(dir, 'fx-gates.js'), gates('true'));
      write('fx-router-consts.js', router()
        .replace("const router = express.Router();", "const { gateOn } = require('./server/config/fx-gates');\nconst CAP = 7;\nconst router = express.Router();")
        .replace('WINDOW + IMPORTED', 'WINDOW + IMPORTED + CAP + (gateOn() ? 1 : 0)'));
      const before = hashFor();
      expect(before).toMatchObject({ safe: true, signals: [], unresolved: [] });
      const row = rowFor(before);
      expect(before.constants.join('\n')).toContain('CAP = 7');
      expect(before.constants.join('\n')).not.toContain('GATES');
      fs.writeFileSync(path.join(dir, 'fx-gates.js'), gates('false').replace('GATES.fast === true', 'GATES.fast === false && true'));
      const afterConfig = hashFor();
      expect(afterConfig.hash).toBe(before.hash);
      expect(checkReview(endpointFingerprint([afterConfig]), row)).toBeNull();
      write('fx-router-consts.js', fs.readFileSync(path.join(FIXTURE_DIR, 'fx-router-consts.js'), 'utf8').replace('CAP = 7', 'CAP = 8'));
      expect(checkReview(endpointFingerprint([hashFor()]), row)).toMatch(/handler chain changed/);
    });
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
