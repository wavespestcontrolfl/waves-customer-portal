/**
 * Termite annual plan — slice 6a, customer online decline (portal).
 *
 *   GET  /api/property/termite-annual-plan          (My Plan renewal card(s))
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
 *   - GET returns EVERY applicable term (codex round-1 P1 — a multi-property
 *     account can carry more than one overlapping termite annual term), each
 *     with its own independent canDecline.
 *   - A body-supplied termId (codex round-1 P1) is always re-matched by the
 *     SERVICE against customer_id = req.customerId AND annual_plan_version
 *     NOT NULL — it can never target another customer's term. No termId
 *     keeps the legacy single-current-term behavior.
 *   - Online decline is available BEFORE installation too (codex round-1
 *     P1, reversing the earlier "paid, installed plan only" restriction).
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
  // The REAL shared eligibility rule — GET's canDecline must match the write.
  termiteDeclineBlockedReason: (...args) => jest.requireActual('../services/annual-prepay-renewals').termiteDeclineBlockedReason(...args),
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
const { etDateString } = require('../utils/datetime-et');

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

  test('query is scoped to the authenticated customer, filters out non-termite prepay terms, and keeps only applicable status shapes', async () => {
    await invoke(getHandler());
    expect(state.whereArgs).toContainEqual([{ customer_id: 'cust-1' }]);
    expect(state.whereArgs).toContainEqual(['annual_plan_version']);
    // codex round-1 P2: the applicable-status predicate (active/
    // renewal_pending/payment_pending OR the decided-lapse shape) — never a
    // bare whereIn that would silently drop the decided-lapse OR-branch.
    expect(state.whereArgs.some((args) => typeof args[0] === 'function')).toBe(true);
  });

  test('a live undecided term reports its renewal date, fee, and canDecline:true', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
    }];
    const { body } = await invoke(getHandler());
    expect(body).toEqual({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
  });

  // codex round-1 P1: a multi-property account can carry more than one
  // overlapping termite annual term — every applicable one comes back,
  // ordered by term_end, each with its OWN independent canDecline.
  test('a multi-property account with two overlapping terms gets both, each with its own canDecline', async () => {
    state.rows = [
      {
        id: 'term-a', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
      {
        id: 'term-b', term_end: '2027-08-01', prepay_amount: '600.00', status: 'payment_pending', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: null,
      },
    ];
    const { body } = await invoke(getHandler());
    expect(body).toEqual({
      available: true,
      terms: [
        { id: 'term-a', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true },
        { id: 'term-b', termEnd: '2027-08-01', prepayAmount: 600, declined: false, canDecline: false },
      ],
    });
  });

  test('an already-declined term reports declined:true and canDecline:false', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'cancelled', renewal_decision: 'cancel',
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ declined: true, canDecline: false }));
  });

  test('an unpaid (payment_pending) plan never offers the decline control', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'payment_pending', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ declined: false, canDecline: false }));
  });

  // codex round-1 P1: REVERSES the earlier "paid, installed plan only"
  // restriction — online decline is available BEFORE installation too.
  test('an original plan still awaiting installation NOW offers the decline control', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: null,
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ declined: false, canDecline: true }));
  });

  test('a term already decided to renew hides the decline control (canDecline:false)', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'renewed', renewal_decision: 'renew',
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ declined: false, canDecline: false }));
  });

  // codex round-1 P1: strictly BEFORE the renewal date — a term ending
  // exactly today has already reached it, so it still shows (not yet
  // excluded by the term_end >= today query filter) but is not declinable.
  test('a term ending exactly today still shows but is not declinable (equality counts as ended)', async () => {
    state.rows = [{
      id: 'term-1', term_end: etDateString(), prepay_amount: '450.00', status: 'active', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ declined: false, canDecline: false }));
  });
});

describe('POST /api/property/termite-annual-plan/decline', () => {
  // codex round-1 P1: the route now forwards a body-supplied termId (a
  // multi-property account picks WHICH overlapping term to decline) — but
  // the customer identity NEVER comes from the body, and the termId is only
  // ever a selector the SERVICE re-matches against customer_id =
  // req.customerId AND annual_plan_version NOT NULL, so it can never target
  // another customer's term.
  test('forwards a body-supplied termId, but the customerId always comes from req.customerId, never the body', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-someone-elses', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    await invoke(postHandler(), { customerId: 'cust-1', body: { termId: 'term-someone-elses', customerId: 'cust-2' } });
    expect(mockDeclineTermiteAnnualRenewal).toHaveBeenCalledWith({ customerId: 'cust-1', termId: 'term-someone-elses' });
  });

  test('no termId in the body keeps the legacy single-current-term behavior', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    await invoke(postHandler());
    expect(mockDeclineTermiteAnnualRenewal).toHaveBeenCalledWith({ customerId: 'cust-1', termId: null });
  });

  test('a non-string body termId (e.g. an object/array injection attempt) is ignored, not forwarded', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    await invoke(postHandler(), { body: { termId: { $ne: null } } });
    expect(mockDeclineTermiteAnnualRenewal).toHaveBeenCalledWith({ customerId: 'cust-1', termId: null });
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
