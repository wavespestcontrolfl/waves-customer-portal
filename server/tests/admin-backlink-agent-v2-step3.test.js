/**
 * Backlink Manager v2 step 3 — admin route contract:
 *  - POST /registry/jobs/investigate runs the investigator once, bounded,
 *    dryRun passed through (gated flows back verbatim from the service).
 *  - GET /registry attaches the best-path summary to each row (§11 table).
 *  - GET /registry/:id returns domain + paths + touches + placements + attempts.
 *  - PATCH /registry/:id: watch / reject / reopen only; lane-owned aggregate
 *    states (ready_to_acquire/acquiring/acquired) are refused; unknown action → 400.
 * Handlers are invoked directly off the router stack (no supertest at root).
 */
const mockState = {
  domains: [],
  firstDomain: undefined,
  paths: [],
  touches: [],
  placements: [],
  updates: [],
};

jest.mock('../models/db', () => {
  const mk = (table) => {
    const q = {
      _table: table,
      where: jest.fn(() => q), whereIn: jest.fn(() => q), whereILike: jest.fn(() => q),
      whereNotIn: jest.fn((col, arr) => { q._notIn = { col, arr }; return q; }),
      clone: () => q, orderBy: () => q, orderByRaw: () => q, limit: () => q, select: () => q,
      offset: () => Promise.resolve(mockState.domains),
      first: jest.fn(async () => (table === 'seo_link_domains' ? mockState.firstDomain : undefined)),
      update: jest.fn(async (patch) => {
        // honor the conditional UPDATE's whereNotIn guard like Postgres would
        if (q._notIn && q._notIn.col === 'agent_state' && mockState.firstDomain && q._notIn.arr.includes(mockState.firstDomain.agent_state)) return 0;
        mockState.updates.push({ table, patch });
        return 1;
      }),
      then: (res, rej) => Promise.resolve(
        table === 'seo_link_acquisition_paths' ? mockState.paths
          : table === 'seo_link_domain_sources' ? mockState.touches
            : table === 'seo_link_prospects' ? mockState.placements : [],
      ).then(res, rej),
    };
    return q;
  };
  return jest.fn((table) => mk(table));
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/seo/link-registry-intake', () => ({ intake: jest.fn(), resolveIntakeItems: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/seo/link-path-investigator', () => ({
  investigatePaths: jest.fn(async () => ({ gated: true, selected: 7, investigated: 0 })),
}));

const router = require('../routes/admin-backlink-agent-v2');
const { investigatePaths } = require('../services/seo/link-path-investigator');
const { isEnabled } = require('../config/feature-gates');

function handler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function call(fn, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ body, query, params }, res, (err) => reject(err || new Error('next()')));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { domains: [], firstDomain: undefined, paths: [], touches: [], placements: [], updates: [] });
});

describe('POST /registry/jobs/investigate', () => {
  test('runs the investigator bounded with dryRun passed through; gated flows to the client', async () => {
    const post = handler('post', '/registry/jobs/:job');
    const r = await call(post, { params: { job: 'investigate' }, body: { dryRun: 'true', limit: '5000' } });
    expect(r.body).toEqual({ job: 'investigate', gated: true, selected: 7, investigated: 0 });
    expect(investigatePaths).toHaveBeenCalledWith(expect.anything(), { dryRun: true, limit: 1000 });
    // no explicit limit ⇒ the service's own LINK_INVESTIGATOR_BATCH default
    await call(post, { params: { job: 'investigate' }, body: {} });
    expect(investigatePaths).toHaveBeenLastCalledWith(expect.anything(), { dryRun: false });
  });
  test('the 404 names investigate among the valid jobs', async () => {
    const r = await call(handler('post', '/registry/jobs/:job'), { params: { job: 'nuke' } });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/investigate/);
  });
  test('a live gated-on run starts in the background and responds immediately (Codex PR r1 P1)', async () => {
    isEnabled.mockReturnValue(true);
    let resolveRun;
    investigatePaths.mockReturnValueOnce(new Promise((res) => { resolveRun = res; }));
    const r = await call(handler('post', '/registry/jobs/:job'), { params: { job: 'investigate' }, body: {} });
    expect(r.body).toEqual({ job: 'investigate', started: true }); // did NOT wait for the run
    expect(investigatePaths).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
    resolveRun({ selected: 1, investigated: 1, qualified: 1, watching: 0, notReproducible: 0, pathRefreshes: 0, pathsWritten: 1, failed: [], fetches: 3, llmCalls: 1 });
    isEnabled.mockReturnValue(false);
  });
});

describe('GET /registry', () => {
  test('attaches the best-path summary to rows that have one', async () => {
    mockState.domains = [
      { id: 'd1', domain: 'a.com', best_path_id: 'p1' },
      { id: 'd2', domain: 'b.com', best_path_id: null },
    ];
    mockState.paths = [{ id: 'p1', acquisition_type: 'paid_listing', estimated_cost_cents: 9500, currency: 'USD', expected_rel: 'dofollow', confidence: '0.70', payment_required: true }];
    const r = await call(handler('get', '/registry'), {});
    expect(r.body.items[0].best_path).toMatchObject({ id: 'p1', acquisition_type: 'paid_listing' });
    expect(r.body.items[1].best_path).toBeNull();
  });
  test('no best paths at all ⇒ no path query, rows unchanged', async () => {
    mockState.domains = [{ id: 'd2', domain: 'b.com', best_path_id: null }];
    const r = await call(handler('get', '/registry'), {});
    expect(r.body.items).toEqual([{ id: 'd2', domain: 'b.com', best_path_id: null }]);
  });
});

describe('GET /registry/:id', () => {
  test('404 on a missing domain', async () => {
    const r = await call(handler('get', '/registry/:id'), { params: { id: 'nope' } });
    expect(r.status).toBe(404);
  });
  test('returns domain + paths + touches + placements + attempts', async () => {
    mockState.firstDomain = { id: 'd1', domain: 'a.com', agent_state: 'qualified' };
    mockState.paths = [{ id: 'p1' }];
    mockState.touches = [{ source: 'competitor_gap' }];
    mockState.placements = [{ id: 'pl1', status: 'prospect' }];
    const r = await call(handler('get', '/registry/:id'), { params: { id: 'd1' } });
    expect(r.body).toEqual({
      domain: mockState.firstDomain, paths: mockState.paths, touches: mockState.touches, placements: mockState.placements, attempts: mockState.attempts || [],
    });
  });
});

describe('PATCH /registry/:id', () => {
  const patch = () => handler('patch', '/registry/:id');
  test('unknown action → 400 naming the valid set', async () => {
    const r = await call(patch(), { params: { id: 'd1' }, body: { action: 'acquire' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/watch, reject, reopen/);
  });
  test('404 on a missing domain', async () => {
    const r = await call(patch(), { params: { id: 'nope' }, body: { action: 'watch' } });
    expect(r.status).toBe(404);
  });
  test.each([['ready_to_acquire'], ['acquiring'], ['acquired']])('lane-owned state %s is refused with 409', async (agentState) => {
    mockState.firstDomain = { id: 'd1', domain: 'a.com', agent_state: agentState };
    const r = await call(patch(), { params: { id: 'd1' }, body: { action: 'reject' } });
    expect(r.status).toBe(409);
    expect(mockState.updates).toHaveLength(0);
  });
  test('watch sets watching + a recheck date; reject/reopen clear it', async () => {
    mockState.firstDomain = { id: 'd1', domain: 'a.com', agent_state: 'qualified' };
    const w = await call(patch(), { params: { id: 'd1' }, body: { action: 'watch' } });
    expect(w.body.agent_state).toBe('watching');
    expect(mockState.updates[0].patch.agent_state).toBe('watching');
    expect(mockState.updates[0].patch.watch_recheck_at).toBeInstanceOf(Date);
    const rj = await call(patch(), { params: { id: 'd1' }, body: { action: 'reject' } });
    expect(rj.body.agent_state).toBe('rejected');
    expect(mockState.updates[1].patch.watch_recheck_at).toBeNull();
    const ro = await call(patch(), { params: { id: 'd1' }, body: { action: 'reopen' } });
    expect(ro.body.agent_state).toBe('investigating');
    // an explicit Reopen is a fresh mandate: the failure backoff is cleared (Codex PR r1 P2)
    expect(mockState.updates[2].patch.investigate_after).toBeNull();
    expect(mockState.updates[2].patch.investigate_failures).toBe(0);
    expect(mockState.updates[0].patch.investigate_after).toBeUndefined(); // watch/reject leave the backoff alone
  });
  test('reopen clears the probe-tail deferral marker — a fresh mandate gets its own tail pass (Codex PR r8 P2)', async () => {
    mockState.firstDomain = { id: 'd1', domain: 'a.com', agent_state: 'watching', score_reasons: 'DR 40 · downgraded: terminal verdict deferred: unfetched candidate URLs remain' };
    await call(patch(), { params: { id: 'd1' }, body: { action: 'reopen' } });
    expect(mockState.updates[0].patch.score_reasons).toBe('DR 40');
    // a reopen with no marker leaves score_reasons untouched
    mockState.firstDomain = { id: 'd1', domain: 'a.com', agent_state: 'watching', score_reasons: 'DR 40' };
    await call(patch(), { params: { id: 'd1' }, body: { action: 'reopen' } });
    expect(mockState.updates[1].patch.score_reasons).toBeUndefined();
  });
});
