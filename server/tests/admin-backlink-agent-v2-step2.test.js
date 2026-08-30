/**
 * Backlink Manager v2 step 2 — admin route contract:
 *  - GET /intake-items validates state, lists items + per-state counts.
 *  - POST /registry/jobs/:job runs exactly one bounded step-2 service (resolve /
 *    baseline / gap / enrich) with dryRun passed through; unknown job → 404.
 * Handlers are invoked directly off the router stack (no supertest at root).
 */
jest.mock('../models/db', () => {
  const rows = [{ id: 'i1', state: 'pending', raw_url: 'bit.ly/a' }];
  const counts = [{ state: 'pending', c: '1' }, { state: 'resolved', c: '2' }];
  const mk = () => {
    const q = {
      where: jest.fn(() => q), whereILike: jest.fn(() => q), orWhereILike: jest.fn(() => q),
      clone: () => q, orderBy: () => q, limit: () => q, offset: () => Promise.resolve(rows),
      select: () => q, count: () => q, groupBy: () => Promise.resolve(counts),
      first: jest.fn(async () => undefined), insert: jest.fn(async () => [{ id: 'q1' }]),
    };
    return q;
  };
  return jest.fn(() => mk());
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/seo/link-registry-intake', () => ({ intake: jest.fn(), resolveIntakeItems: jest.fn(async () => ({ claimed: 1, resolved: 1 })) }));
jest.mock('../services/seo/link-registry-baseline', () => ({ importExistingBacklinks: jest.fn(async () => ({ scanned: 3 })) }));
jest.mock('../services/seo/link-registry-gap-ingest', () => ({ ingestCompetitorGap: jest.fn(async () => ({ scanned: 9 })) }));
jest.mock('../services/seo/link-registry-enrich', () => ({ enrichDomains: jest.fn(async () => ({ gated: true, selected: 4 })) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (name, fn) => fn()) }));

const router = require('../routes/admin-backlink-agent-v2');
const { intake, resolveIntakeItems } = require('../services/seo/link-registry-intake');
const { importExistingBacklinks } = require('../services/seo/link-registry-baseline');
const { ingestCompetitorGap } = require('../services/seo/link-registry-gap-ingest');
const { enrichDomains } = require('../services/seo/link-registry-enrich');
const { runExclusive } = require('../utils/cron-lock');

function handler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function call(fn, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ body, query, params, technician: { name: 'adam' } }, res, (err) => reject(err || new Error('next()')));
  });
}

describe('GET /intake-items', () => {
  test('rejects an unknown state; lists items with per-state counts', async () => {
    const get = handler('get', '/intake-items');
    const bad = await call(get, { query: { state: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/pending, unresolved, resolved, dropped/);
    const ok = await call(get, { query: { state: 'pending', q: 'bit' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ items: [{ id: 'i1', state: 'pending', raw_url: 'bit.ly/a' }], counts: { pending: 1, resolved: 2 } });
  });
});

describe('POST /registry/jobs/:job', () => {
  test('unknown job → 404 naming the valid set', async () => {
    const r = await call(handler('post', '/registry/jobs/:job'), { params: { job: 'nuke' } });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/resolve, baseline, gap, enrich/);
  });
  test('the legacy Add-URLs queue route ALSO feeds the registry intake (one pipeline, never two)', async () => {
    intake.mockResolvedValueOnce({ inserted: 2, existing: 1, items: { pending: 1 } });
    const post = handler('post', '/queue');
    const r = await call(post, { body: { urls: ['https://dir.example/add', 'bit.ly/x'] } });
    expect(intake).toHaveBeenCalledWith(expect.anything(), { text: 'https://dir.example/add\nbit.ly/x', source: 'list_import', sourceDetail: expect.stringMatching(/^legacy_queue_add:\d{4}-\d{2}-\d{2}$/) });
    expect(r.body.registry).toEqual({ inserted: 2, existing: 1, pending: 1 });
  });

  test('each job runs its service once, bounded, with dryRun passed through', async () => {
    const post = handler('post', '/registry/jobs/:job');
    expect((await call(post, { params: { job: 'resolve' }, body: { limit: '5000' } })).body).toEqual({ job: 'resolve', claimed: 1, resolved: 1 });
    expect(resolveIntakeItems).toHaveBeenCalledWith(expect.anything(), { limit: 1000, dryRun: false });
    await call(post, { params: { job: 'resolve' }, body: { dryRun: true } });
    expect(resolveIntakeItems).toHaveBeenLastCalledWith(expect.anything(), { limit: 50, dryRun: true });

    expect((await call(post, { params: { job: 'baseline' }, body: { dryRun: 'true' } })).body).toEqual({ job: 'baseline', scanned: 3 });
    expect(importExistingBacklinks).toHaveBeenCalledWith(expect.anything(), { dryRun: true, limit: null });
    expect(runExclusive).not.toHaveBeenCalled(); // dryRun reads only
    // a live baseline import runs under the backlink scan's own lease; a held lease is reported, never queued
    expect((await call(post, { params: { job: 'baseline' }, body: {} })).body).toEqual({ job: 'baseline', scanned: 3 });
    expect(runExclusive).toHaveBeenCalledWith('backlink-scan', expect.any(Function), { recordHealth: false });
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    expect((await call(post, { params: { job: 'baseline' }, body: {} })).body).toEqual({ job: 'baseline', skipped: 'lease_held' });

    expect((await call(post, { params: { job: 'gap' }, body: { limit: 20 } })).body).toEqual({ job: 'gap', scanned: 9 });
    expect(ingestCompetitorGap).toHaveBeenCalledWith(expect.anything(), { dryRun: false, limit: 20 });

    expect((await call(post, { params: { job: 'enrich' }, body: {} })).body).toEqual({ job: 'enrich', gated: true, selected: 4 });
    expect(enrichDomains).toHaveBeenCalledWith(expect.anything(), { dryRun: false, limit: 200, force: false });
  });
});
