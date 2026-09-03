/**
 * Backlink Manager v2 step 4 (PR 2b) — the Owner-queue route contract:
 *  - GET /owner-queue → the cards + the GATE_LINK_AUTHORITY state
 *  - POST /owner-queue/rows/:id/approve, /owner-queue/domains/:id/reject|watch,
 *    /registry/:id/acquire-anyway → the signed-in admin is the actor, the body
 *    is passed through, and the service's 400/404/409 become responses while
 *    any other failure reaches the error handler.
 *  - PATCH /registry/:id still applies the shared registry action (1:1 with
 *    the pre-2b behavior: lane-owned ⇒ 409, watch ⇒ 30-day recheck).
 * Handlers are invoked directly off the router stack (no supertest at root).
 */
const mockState = { domains: [], updates: [], sourceUpdates: [] };

jest.mock('../models/db', () => {
  const mk = (table) => {
    const q = {
      _preds: [],
      where(a) { if (typeof a === 'object') q._preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v)); return q; },
      whereNotIn(col, arr) { q._preds.push((r) => !arr.includes(r[col])); return q; },
      whereNull: () => q, orderBy: () => q, limit: () => q, forUpdate: () => q,
      select: async () => [],
      first: async () => (table === 'seo_link_domains' ? mockState.domains.find((d) => q._preds.every((p) => p(d))) : undefined),
      update: async (u) => {
        if (table === 'seo_link_domain_sources') { mockState.sourceUpdates.push(u); return 1; }
        const hit = mockState.domains.filter((d) => q._preds.every((p) => p(d)));
        for (const d of hit) Object.assign(d, u);
        mockState.updates.push({ table, u, n: hit.length });
        return hit.length;
      },
    };
    return q;
  };
  const db = jest.fn((table) => mk(table));
  db.transaction = async (cb) => cb(db);
  return db;
});
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next() }));
jest.mock('../services/seo/link-registry-intake', () => ({ intake: jest.fn(), resolveIntakeItems: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((g) => g === 'linkAuthority') }));
jest.mock('../services/seo/link-path-investigator', () => ({ investigatePaths: jest.fn(), LOCK_KEY: 'link-path-investigator' }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/link-authority-bridge', () => ({ runAuthorityBridge: jest.fn(), LOCK_KEY: 'link-authority-bridge' }));
jest.mock('../services/seo/link-owner-queue', () => {
  class OwnerQueueError extends Error { constructor(status, message) { super(message); this.status = status; } }
  return {
    OwnerQueueError,
    listOwnerQueue: jest.fn(async () => ({ cards: [{ placement: { id: 'p1' } }] })),
    approveRow: jest.fn(async () => ({ approval: { dimension: 'execution', action: 'acquire', instance_key: '-:1' }, attached: ['a1'], bridge: { gated: false, released: 1 } })),
    decideDomain: jest.fn(async () => ({ domain: 'example.org', agent_state: 'rejected', audited: 1 })),
    acquireAnyway: jest.fn(async () => ({ domain: 'example.org', floors: [{ floor: 'score' }], bridge: { gated: false, parked: 1 }, awaiting: 1 })),
  };
});

const router = require('../routes/admin-backlink-agent-v2');
const Q = require('../services/seo/link-owner-queue');

function handler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const run = async (method, routePath, req) => {
  const r = res();
  let err;
  await handler(method, routePath)({ body: {}, query: {}, params: {}, technician: { id: 7, name: 'Adam' }, ...req }, r, (e) => { err = e; });
  if (err) throw err;
  return r;
};

beforeEach(() => {
  mockState.domains = [{ id: 'd1', domain: 'example.org', agent_state: 'qualified', score_reasons: null }, { id: 'd2', domain: 'owned.org', agent_state: 'acquiring', score_reasons: null }];
  mockState.updates = []; mockState.sourceUpdates = [];
  jest.clearAllMocks();
});

describe('GET /owner-queue', () => {
  test('returns the cards with the gate state', async () => {
    const r = await run('get', '/owner-queue', {});
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ cards: [{ placement: { id: 'p1' } }], gateOn: true });
  });
});

describe('the owner clicks', () => {
  test('approve passes the row id, the admin name, the amount and the note through', async () => {
    const r = await run('post', '/owner-queue/rows/:id/approve', { params: { id: 'a1' }, body: { approved_amount_cents: 4500, note: 'ok' } });
    expect(r.statusCode).toBe(200);
    expect(Q.approveRow).toHaveBeenCalledWith(expect.anything(), { authorityId: 'a1', actor: 'Adam', approvedAmountCents: 4500, note: 'ok' });
    expect(r.body.attached).toEqual(['a1']);
  });

  test('an admin without a name is identified by id; no technician ⇒ the service refuses 400', async () => {
    await run('post', '/owner-queue/rows/:id/approve', { params: { id: 'a1' }, technician: { id: 9 } });
    expect(Q.approveRow).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ actor: '9' }));
    Q.approveRow.mockRejectedValueOnce(new Q.OwnerQueueError(400, 'an approving admin identity is required'));
    const r = await run('post', '/owner-queue/rows/:id/approve', { params: { id: 'a1' }, technician: null });
    expect(r.statusCode).toBe(400);
    expect(Q.approveRow).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ actor: null }));
  });

  test('reject / watch map to the domain decision; acquire-anyway to the waiver', async () => {
    let r = await run('post', '/owner-queue/domains/:id/reject', { params: { id: 'd1' }, body: { note: 'no' } });
    expect(r.statusCode).toBe(200);
    expect(Q.decideDomain).toHaveBeenLastCalledWith(expect.anything(), { domainId: 'd1', decision: 'rejected', actor: 'Adam', note: 'no' });
    r = await run('post', '/owner-queue/domains/:id/watch', { params: { id: 'd1' } });
    expect(Q.decideDomain).toHaveBeenLastCalledWith(expect.anything(), { domainId: 'd1', decision: 'watch', actor: 'Adam', note: null });
    r = await run('post', '/registry/:id/acquire-anyway', { params: { id: 'd1' }, body: { note: 'chamber' } });
    expect(r.statusCode).toBe(200);
    expect(Q.acquireAnyway).toHaveBeenLastCalledWith(expect.anything(), { domainId: 'd1', actor: 'Adam', note: 'chamber' });
    expect(r.body.awaiting).toBe(1);
  });

  test('service refusals become their status; anything else reaches the error handler', async () => {
    Q.approveRow.mockRejectedValueOnce(new Q.OwnerQueueError(409, 'inputs changed since the card'));
    let r = await run('post', '/owner-queue/rows/:id/approve', { params: { id: 'a1' } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: 'inputs changed since the card' });
    Q.acquireAnyway.mockRejectedValueOnce(new Q.OwnerQueueError(404, 'registry domain not found'));
    r = await run('post', '/registry/:id/acquire-anyway', { params: { id: 'nope' } });
    expect(r.statusCode).toBe(404);
    Q.decideDomain.mockRejectedValueOnce(new Error('connection reset'));
    await expect(run('post', '/owner-queue/domains/:id/reject', { params: { id: 'd1' } })).rejects.toThrow('connection reset');
  });
});

describe('PATCH /registry/:id after the shared-writer extraction', () => {
  test('reject / watch are the Owner-queue decision in every state: decideDomain with the actor and note, its refusal status passed through', async () => {
    const r = await run('patch', '/registry/:id', { params: { id: 'd1' }, body: { action: 'reject', note: 'spammy' } }); // d1 = qualified
    expect(Q.decideDomain).toHaveBeenCalledWith(expect.anything(), { domainId: 'd1', decision: 'rejected', actor: 'Adam', note: 'spammy' });
    expect(r.body).toMatchObject({ id: 'd1', domain: 'example.org', agent_state: 'rejected', audited: 1 });
    expect(mockState.updates).toHaveLength(0); // the service wrote it, not the state-only path
    mockState.domains[0].agent_state = 'investigating'; // a domain that left the queue is the same decision
    await run('patch', '/registry/:id', { params: { id: 'd1' }, body: { action: 'watch' } });
    expect(Q.decideDomain).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ domainId: 'd1', decision: 'watch', note: null }));
    Q.decideDomain.mockRejectedValueOnce(new Q.OwnerQueueError(409, 'lane-owned'));
    const refused = await run('patch', '/registry/:id', { params: { id: 'd2' }, body: { action: 'reject' } });
    expect(refused.statusCode).toBe(409);
    expect(mockState.domains[1].agent_state).toBe('acquiring');
    const bad = await run('patch', '/registry/:id', { params: { id: 'd1' }, body: { action: 'nuke' } });
    expect(bad.statusCode).toBe(400);
  });

  test('reopen stays the plain registry action: clears the marker and the backoff; lane-owned ⇒ 409; decideDomain untouched', async () => {
    mockState.domains[0].agent_state = 'rejected';
    mockState.domains[0].rejected_by = 'owner';
    const r = await run('patch', '/registry/:id', { params: { id: 'd1' }, body: { action: 'reopen' } });
    expect(r.statusCode).toBe(200);
    expect(mockState.domains[0]).toMatchObject({ agent_state: 'investigating', rejected_by: null, investigate_after: null, investigate_failures: 0, investigate_claim_token: null, probe_coverage_mask: 0 });
    expect(mockState.sourceUpdates).toHaveLength(1);
    expect(Q.decideDomain).not.toHaveBeenCalled();
    const owned = await run('patch', '/registry/:id', { params: { id: 'd2' }, body: { action: 'reopen' } });
    expect(owned.statusCode).toBe(409);
    expect(mockState.domains[1].agent_state).toBe('acquiring');
  });
});
