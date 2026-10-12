/**
 * The Intelligence Bar's admin read catalog (owner ruling 2026-10-12) is
 * generated from the admin request census. These tests keep it from
 * drifting from the census silently and keep anything that is not a plain
 * JSON data read out of it.
 */
const fs = require('fs');
const { buildCatalog, serialize, OUT_FILE, EXCLUSIONS_FILE, CENSUS_FILE } = require('../../scripts/build-ib-admin-read-catalog');
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
  for (const row of file.allow) {
    expect(Array.isArray(row.signals) && row.signals.length > 0).toBe(true);
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
