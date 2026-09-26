/**
 * Termite annual plan — slice 6a, customer online decline (portal).
 *
 *   GET  /api/property/termite-annual-plan          (My Plan renewal card)
 *   POST /api/property/termite-annual-plan/decline  (records the decline)
 *
 * Dark behind termiteAnnualPlanSelectionEnabled() (GATE_TERMITE_ANNUAL_PLAN
 * AND GATE_CANCEL_FLOW_V2 — server/config/feature-gates.js: "also requires
 * GATE_CANCEL_FLOW_V2 for online nonrenewal"). The route-level contract this
 * file locks in:
 *   - Both endpoints are behind `authenticate` (router.use at the top of
 *     property.js) — req.customerId is the ONLY customer identity source;
 *     nothing in the request body can target another customer's term.
 *   - Gate off => 404/refused (GET answers 200 {available:false}, matching
 *     every other dark portal read on this router; POST answers 404).
 *   - The service call never receives an externally-supplied termId — a
 *     customer can only ever decline their OWN current term.
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = req.customerId || 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendAccountUpdated: jest.fn(async () => {}),
}));
jest.mock('../services/termite-stations', () => ({
  buildStationMapCurrentContext: jest.fn(() => ({ available: false })),
}));

const mockDeclineTermiteAnnualRenewal = jest.fn();
jest.mock('../services/annual-prepay-renewals', () => ({
  declineTermiteAnnualRenewal: (...args) => mockDeclineTermiteAnnualRenewal(...args),
}));

const state = { rows: [], fail: false, whereArgs: [] };
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const result = () => (state.fail ? Promise.reject(new Error('db down')) : Promise.resolve(state.rows));
    const q = {};
    q.where = jest.fn((...a) => { state.whereArgs.push(a); return q; });
    q.whereNotNull = jest.fn((...a) => { state.whereArgs.push(a); return q; });
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.first = jest.fn(async () => state.rows[0] || null);
    q.then = (ok, bad) => result().then(ok, bad);
    q.catch = (fn) => result().catch(fn);
    return q;
  });
  db.raw = jest.fn((sql) => sql);
  return db;
});

const db = require('../models/db');
const propertyRouter = require('../routes/property');

function routeHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, { customerId = 'cust-1', body = {} } = {}) {
  const req = { customerId, query: {}, params: {}, body };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
    set() { return this; },
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { statusCode, body: jsonBody };
}

const getHandler = () => routeHandler(propertyRouter, 'get', '/termite-annual-plan');
const postHandler = () => routeHandler(propertyRouter, 'post', '/termite-annual-plan/decline');

beforeEach(() => {
  jest.clearAllMocks();
  state.rows = [];
  state.fail = false;
  state.whereArgs = [];
  process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
});

afterAll(() => {
  delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  delete process.env.GATE_CANCEL_FLOW_V2;
});

describe('GET /api/property/termite-annual-plan', () => {
  test('gate off (either half): 200 {available:false, reason:disabled} without querying', async () => {
    delete process.env.GATE_CANCEL_FLOW_V2;
    const { statusCode, body } = await invoke(getHandler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({ available: false, reason: 'disabled' });
    expect(db).not.toHaveBeenCalled();
  });

  test('no current term: 200 {available:false, reason:no_term}', async () => {
    const { statusCode, body } = await invoke(getHandler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({ available: false, reason: 'no_term' });
  });

  test('query is scoped to the authenticated customer and filters out non-termite prepay terms', async () => {
    await invoke(getHandler());
    expect(state.whereArgs).toContainEqual([{ customer_id: 'cust-1' }]);
    expect(state.whereArgs).toContainEqual(['annual_plan_version']);
  });

  test('a live undecided term reports its renewal date, fee, and canDecline:true', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
    }];
    const { body } = await invoke(getHandler());
    expect(body).toEqual({
      available: true,
      term: { id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true },
    });
  });

  test('an already-declined term reports declined:true and canDecline:false', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'cancelled', renewal_decision: 'cancel',
    }];
    const { body } = await invoke(getHandler());
    expect(body.term).toEqual(expect.objectContaining({ declined: true, canDecline: false }));
  });

  test('a term already decided to renew hides the decline control (canDecline:false)', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'renewed', renewal_decision: 'renew',
    }];
    const { body } = await invoke(getHandler());
    expect(body.term).toEqual(expect.objectContaining({ declined: false, canDecline: false }));
  });
});

describe('POST /api/property/termite-annual-plan/decline', () => {
  test('calls the service with ONLY the authenticated customerId — a body-supplied termId can never target another term', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    await invoke(postHandler(), { customerId: 'cust-1', body: { termId: 'term-someone-elses', customerId: 'cust-2' } });
    expect(mockDeclineTermiteAnnualRenewal).toHaveBeenCalledWith({ customerId: 'cust-1' });
  });

  test('success: 200 with the service result', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    const { statusCode, body } = await invoke(postHandler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      available: true, ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
  });

  test('idempotent replay: 200 with alreadyDeclined:true', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: true,
    });
    const { statusCode, body } = await invoke(postHandler());
    expect(statusCode).toBe(200);
    expect(body.alreadyDeclined).toBe(true);
  });

  test('gate disabled: 404', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'disabled' });
    const { statusCode, body } = await invoke(postHandler());
    expect(statusCode).toBe(404);
    expect(body).toEqual(expect.objectContaining({ available: false, ok: false, reason: 'disabled' }));
  });

  test('no eligible term: 404', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'no_term' });
    const { statusCode } = await invoke(postHandler());
    expect(statusCode).toBe(404);
  });

  test('term already ended: 409', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'term_ended', termId: 'term-1', termEnd: '2026-01-01' });
    const { statusCode, body } = await invoke(postHandler());
    expect(statusCode).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      available: false, ok: false, reason: 'term_ended', termId: 'term-1', termEnd: '2026-01-01',
    }));
  });

  test('conflicting decision already on file: 409', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'already_decided', decision: 'renew', termId: 'term-1' });
    const { statusCode } = await invoke(postHandler());
    expect(statusCode).toBe(409);
  });

  test('a thrown service error is passed to next(), not swallowed as a 200', async () => {
    mockDeclineTermiteAnnualRenewal.mockRejectedValue(new Error('db exploded'));
    await expect(invoke(postHandler())).rejects.toThrow('db exploded');
  });
});
