/**
 * Backlink Manager v2 step 1 — admin route contract:
 *  - PROSPECT_STATUSES gains awaiting_owner / watching (the parked pair), both
 *    editable via PATCH, both in the per-domain guard sets, neither leasable.
 *  - POST /opportunities/bulk validates, defaults source_detail, and hands the
 *    text to the intake service (dryRun passes through; no DB touched here).
 * Handlers are invoked directly off the router stack (no supertest at root).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/seo/link-registry-intake', () => ({ intake: jest.fn(async () => ({ inserted: 1, existing: 0, touched: 1, candidates: [{ domain: 'a.example' }], unresolved: [], dropped: [], dryRun: false })) }));

const fs = require('fs');
const path = require('path');
const router = require('../routes/admin-backlink-agent-v2');
const { intake } = require('../services/seo/link-registry-intake');
const { ACTIVE_OUTREACH_STATUSES, IN_FLIGHT_STATUSES } = require('../services/seo/prospect-domain-lock');

function handler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function call(fn, { body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ body, query, technician: { name: 'adam' } }, res, (err) => reject(err || new Error('next()')));
  });
}

describe('status contract (plan §3.3)', () => {
  test('the parked pair is in PROSPECT_STATUSES; awaiting_owner is ACTIVE outreach, watching is in-flight only; the worker leases neither', () => {
    expect(router.PROSPECT_STATUSES).toEqual(['prospect', 'contacted', 'negotiating', 'placed', 'live', 'indexed', 'lost', 'rejected', 'awaiting_owner', 'watching']);
    expect(router.PARKED_STATUSES).toEqual(['awaiting_owner', 'watching']);
    expect(ACTIVE_OUTREACH_STATUSES).toContain('awaiting_owner');
    expect(ACTIVE_OUTREACH_STATUSES).not.toContain('watching');
    expect(IN_FLIGHT_STATUSES).toContain('watching');
    // claim() leases only status='prospect' — pinned in source so a widened claim predicate is a deliberate change
    const worker = fs.readFileSync(path.join(__dirname, '..', 'services/seo/link-prospect-worker.js'), 'utf8');
    const claimBlock = worker.slice(worker.indexOf('async function claim('), worker.indexOf('async function claim(') + 1200);
    expect(claimBlock).toMatch(/\.where\(\{ status: 'prospect' \}\)/);
    expect(claimBlock).not.toMatch(/awaiting_owner|watching/);
  });
  test('PATCH accepts the parked statuses and still rejects unknown ones', async () => {
    const patch = handler('patch', '/prospects/:id');
    const bad = await call(patch, { body: { status: 'parked' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/awaiting_owner, watching/);
  });
});

describe('rolling-deploy compatibility of the board unique key', () => {
  test('every board insert with ON CONFLICT is constraintless (matches the legacy 2-col unique AND the v2 location_key key)', () => {
    const { execSync } = require('child_process');
    const hits = execSync("grep -rln \"seo_link_prospects').insert\" server scripts --include='*.js' | grep -v /tests/", { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).trim().split('\n');
    for (const f of hits) {
      const s = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
      expect({ f, explicitTarget: /onConflict\(\[/.test(s) }).toEqual({ f, explicitTarget: false });
    }
    expect(hits.length).toBeGreaterThanOrEqual(5);
  });
  test('the PATCH page-move dedupes within the row\'s own location scope', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'routes/admin-backlink-agent-v2.js'), 'utf8');
    expect(s).toMatch(/first\('id', 'status', 'target_domain', 'target_page', 'link_type', 'location_key'\)/);
    expect(s).toMatch(/findPlacementRow\(trx, current\.target_domain, patch\.target_page, \{ excludeId: current\.id, location: current\.location_key \}\)/);
  });
});

describe('POST /opportunities/bulk (intake skeleton)', () => {
  const post = handler('post', '/opportunities/bulk');
  beforeEach(() => intake.mockClear());

  test('requires non-empty text; caps size; only list_import / owner_seed from the paste box', async () => {
    expect((await call(post, { body: {} })).status).toBe(400);
    expect((await call(post, { body: { text: '   ' } })).status).toBe(400);
    expect((await call(post, { body: { text: 'x'.repeat(200001) } })).status).toBe(400);
    const src = await call(post, { body: { text: 'a.example', source: 'competitor_gap' } });
    expect(src.status).toBe(400);
    expect(src.body.error).toMatch(/list_import, owner_seed/);
    expect(router.INTAKE_SOURCES).toEqual(['list_import', 'owner_seed']);
    expect(intake).not.toHaveBeenCalled();
  });
  test('defaults source=list_import and a dated paste detail; passes dryRun through; returns the service result', async () => {
    const r = await call(post, { body: { text: 'a.example b.example', dryRun: 'true' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inserted: 1 });
    expect(intake).toHaveBeenCalledWith(expect.anything(), { text: 'a.example b.example', source: 'list_import', sourceDetail: `paste:${require('../utils/datetime-et').etDateString()}`, dryRun: true }); // ET day, never UTC
    await call(post, { body: { text: 'a.example', source: 'owner_seed', source_detail: '  Adam seed list  ' } });
    expect(intake).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ source: 'owner_seed', sourceDetail: 'Adam seed list', dryRun: false }));
  });
  test('the route is mounted under the admin guard (router-level auth) and the GET /registry read exists', () => {
    expect(router.stack.some((l) => !l.route && l.name === 'adminAuthenticate')).toBe(true);
    expect(() => handler('get', '/registry')).not.toThrow();
  });
});
