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
// codex pre-push P1: every decided-lapse row the GET fetches is re-checked
// against this (billing's own live-coverage test) before being shown as
// covered — defaults to true so tests that don't care about refund/dispute
// exclusion (declined-and-still-covered) need no per-test setup.
const mockIsPaidDecidedLapseTerm = jest.fn().mockResolvedValue(true);
// Pre-push audit P1: per-term property label (ownership-scoped lookup — its
// SQL runs for real in termite-annual-plan-property-label-postgres.test.js).
// Defaults to no labels.
const mockTermPropertyLabels = jest.fn().mockResolvedValue(new Map());
jest.mock('../services/annual-prepay-renewals', () => ({
  termPropertyLabelsForCustomer: (...args) => mockTermPropertyLabels(...args),
  declineTermiteAnnualRenewal: (...args) => mockDeclineTermiteAnnualRenewal(...args),
  // The REAL shared eligibility rule — GET's canDecline must match the write.
  termiteDeclineBlockedReason: (...args) => jest.requireActual('../services/annual-prepay-renewals').termiteDeclineBlockedReason(...args),
  whereTermCurrentOrAwaitingInstallation: (...args) => jest.requireActual('../services/annual-prepay-renewals').whereTermCurrentOrAwaitingInstallation(...args),
  isPaidDecidedLapseTerm: (...args) => mockIsPaidDecidedLapseTerm(...args),
  // The REAL provisional-term rule — the card must agree with billing about
  // whether a term_end is still provisional (awaiting installation).
  coverageAwaitsInstallation: (...args) => jest.requireActual('../services/annual-prepay-renewals').coverageAwaitsInstallation(...args),
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

// Pre-push audit P2: the fixtures use fixed term_end dates (2027-05-20,
// 2027-08-01) and canDecline compares them against the ET "today" — pin the
// clock (Date only) so the suite never starts failing once those dates pass.
const PINNED_NOW = new Date('2026-09-26T16:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({
    now: PINNED_NOW,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
  mockIsPaidDecidedLapseTerm.mockResolvedValue(true);
  mockTermPropertyLabels.mockResolvedValue(new Map());
  state.rows = [];
  state.fail = false;
  state.whereArgs = [];
  process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  delete process.env.GATE_CANCEL_FLOW_V2;
});

describe('GET /api/property/termite-annual-plan', () => {
  // Codex r3 P0: the gates control only ISSUING new plans — a customer
  // who already holds a termite annual term keeps the card and its decline
  // (the signed agreement promises online nonrenewal).
  test.each(['GATE_CANCEL_FLOW_V2', 'GATE_TERMITE_ANNUAL_PLAN'])('gate off (%s) with NO existing term: 200 {available:false, reason:disabled}', async (gate) => {
    delete process.env[gate];
    const { statusCode, body } = await invoke(getHandler());
    expect(statusCode).toBe(200);
    expect(body).toEqual({ available: false, reason: 'disabled' });
  });

  test.each(['GATE_CANCEL_FLOW_V2', 'GATE_TERMITE_ANNUAL_PLAN'])('gate off (%s) with an EXISTING termite annual term: the card and its decline control still show', async (gate) => {
    delete process.env[gate];
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
    }];
    const { body } = await invoke(getHandler());
    expect(body.available).toBe(true);
    expect(body.terms[0]).toEqual(expect.objectContaining({ id: 'term-1', canDecline: true }));
  });

  // Codex r3 P1: an original term awaiting installation has a PROVISIONAL
  // term_end — neither the query's date cutoff nor canDecline uses it.
  test('the date cutoff exempts an original term still awaiting installation', async () => {
    await invoke(getHandler());
    const predicates = state.whereArgs.map((args) => args[0]).filter((arg) => typeof arg === 'function');
    const seen = [];
    const fake = {
      where: jest.fn((...args) => { seen.push(['where', ...args]); return fake; }),
      orWhere: jest.fn((fn) => { if (typeof fn === 'function') fn.call(fake, fake); return fake; }),
      whereNotNull: jest.fn((col) => { seen.push(['whereNotNull', col]); return fake; }),
      whereNull: jest.fn((col) => { seen.push(['whereNull', col]); return fake; }),
      whereIn: jest.fn(() => fake),
      andWhere: jest.fn(() => fake),
    };
    predicates.forEach((fn) => fn.call(fake, fake));
    expect(seen).toEqual(expect.arrayContaining([
      ['where', 'term_end', '>=', '2026-09-26'],
      ['whereNull', 'installation_anchored_at'],
      ['whereNull', 'renewed_from_term_id'],
    ]));
  });

  test('a PAST provisional term_end with installation pending still shows and is declinable', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2026-03-01', prepay_amount: '450.00', status: 'active', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: null,
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ id: 'term-1', awaitsInstallation: true, canDecline: true }));
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
      terms: [{
        id: 'term-1', propertyLabel: null, termEnd: '2027-05-20', awaitsInstallation: false, prepayAmount: 450, declined: false, canDecline: true,
      }],
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
    mockTermPropertyLabels.mockResolvedValue(new Map([['term-a', '12 Palm Ave'], ['term-b', '400 Gulf Dr']]));
    const { body } = await invoke(getHandler());
    expect(body).toEqual({
      available: true,
      terms: [
        {
          id: 'term-a', propertyLabel: '12 Palm Ave', termEnd: '2027-05-20', awaitsInstallation: false, prepayAmount: 450, declined: false, canDecline: true,
        },
        {
          id: 'term-b', propertyLabel: '400 Gulf Dr', termEnd: '2027-08-01', awaitsInstallation: true, prepayAmount: 600, declined: false, canDecline: false,
        },
      ],
    });
  });

  // Pre-push audit P1: a multi-property account's cards must be told apart —
  // each term carries its own property label, looked up for req.customerId
  // (never a body-supplied identity) over exactly the terms being returned.
  test('each term carries its own ownership-scoped property label', async () => {
    state.rows = [
      {
        id: 'term-a', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
      {
        id: 'term-b', term_end: '2027-08-01', prepay_amount: '600.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
    ];
    mockTermPropertyLabels.mockResolvedValue(new Map([
      ['term-a', '12 Palm Ave, Bradenton, FL 34202'],
      ['term-b', '400 Gulf Dr, Unit 3, Holmes Beach, FL 34217'],
    ]));
    const { body } = await invoke(getHandler(), { customerId: 'cust-1' });
    expect(mockTermPropertyLabels).toHaveBeenCalledWith('cust-1', ['term-a', 'term-b'], db);
    expect(body.terms.map((term) => [term.id, term.propertyLabel])).toEqual([
      ['term-a', '12 Palm Ave, Bradenton, FL 34202'],
      ['term-b', '400 Gulf Dr, Unit 3, Holmes Beach, FL 34217'],
    ]);
  });

  test('a refunded decided-lapse term is never passed to the label lookup', async () => {
    state.rows = [
      { id: 'term-refunded', term_end: '2027-05-20', prepay_amount: '450.00', status: 'cancelled', renewal_decision: 'cancel' },
      {
        id: 'term-b', term_end: '2027-08-01', prepay_amount: '600.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
    ];
    mockIsPaidDecidedLapseTerm.mockResolvedValue(false);
    await invoke(getHandler());
    expect(mockTermPropertyLabels).toHaveBeenCalledWith('cust-1', ['term-b'], db);
  });

  test('a label lookup failure only drops the labels — the cards still render', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
      annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
    }];
    mockTermPropertyLabels.mockRejectedValue(new Error('labels down'));
    const { statusCode, body } = await invoke(getHandler());
    expect(statusCode).toBe(200);
    expect(body.terms).toEqual([{
      id: 'term-1', propertyLabel: null, termEnd: '2027-05-20', awaitsInstallation: false, prepayAmount: 450, declined: false, canDecline: true,
    }]);
  });

  // Codex r2 P1: with SEVERAL terms a label failure must never yield
  // declinable look-alike cards — 503, which the portal shows as its error
  // + Retry state.
  test('a label lookup failure with several terms fails closed (503), never look-alike declinable cards', async () => {
    state.rows = [
      {
        id: 'term-a', term_end: '2027-05-20', prepay_amount: '450.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
      {
        id: 'term-b', term_end: '2027-08-01', prepay_amount: '600.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
    ];
    mockTermPropertyLabels.mockRejectedValue(new Error('labels down'));
    const { statusCode, body } = await invoke(getHandler());
    expect(statusCode).toBe(503);
    expect(body).toEqual(expect.objectContaining({ available: false, reason: 'labels_unavailable' }));
    expect(body.terms).toBeUndefined();
  });

  const anchoredActive = (id, termEnd, extra = {}) => ({
    id, term_end: termEnd, prepay_amount: '450.00', status: 'active', renewal_decision: null,
    annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z', ...extra,
  });

  test('two terms resolving to the SAME label are told apart by their (anchored) renewal date', async () => {
    state.rows = [anchoredActive('term-a', '2027-05-20'), anchoredActive('term-b', '2027-08-01')];
    mockTermPropertyLabels.mockResolvedValue(new Map([['term-a', '1 Home St, Bradenton, FL 34202'], ['term-b', '1 Home St, Bradenton, FL 34202']]));
    const { body } = await invoke(getHandler());
    expect(body.terms.map((term) => [term.propertyLabel, term.canDecline])).toEqual([
      ['1 Home St, Bradenton, FL 34202 (renews May 20, 2027)', true],
      ['1 Home St, Bradenton, FL 34202 (renews August 1, 2027)', true],
    ]);
  });

  test('a shared label on a term still awaiting installation is marked as such — never its provisional date', async () => {
    state.rows = [anchoredActive('term-a', '2027-05-20'), anchoredActive('term-b', '2027-08-01', { installation_anchored_at: null })];
    mockTermPropertyLabels.mockResolvedValue(new Map([['term-a', '1 Home St'], ['term-b', '1 Home St']]));
    const { body } = await invoke(getHandler());
    expect(body.terms.map((term) => [term.propertyLabel, term.canDecline])).toEqual([
      ['1 Home St (renews May 20, 2027)', true],
      ['1 Home St (awaiting installation)', true],
    ]);
    expect(JSON.stringify(body.terms[1].propertyLabel)).not.toContain('2027');
  });

  test.each([
    ['share a label and both still await installation (no real date to tell them apart)', [
      anchoredActive('term-a', '2027-05-20', { installation_anchored_at: null }),
      anchoredActive('term-b', '2027-08-01', { installation_anchored_at: null }),
    ], new Map([['term-a', '1 Home St'], ['term-b', '1 Home St']]), ['term-a', 'term-b']],
    ['share a label AND a renewal date', [
      anchoredActive('term-a', '2027-05-20'),
      anchoredActive('term-b', '2027-05-20'),
    ], new Map([['term-a', '1 Home St'], ['term-b', '1 Home St']]), ['term-a', 'term-b']],
    ['one has no label at all', [
      anchoredActive('term-a', '2027-05-20'),
      anchoredActive('term-b', '2027-08-01'),
    ], new Map([['term-a', '12 Palm Ave']]), ['term-b']],
  ])('several terms that %s: the indistinguishable ones fail closed (no decline control, propertyUnclear)', async (_label, rows, labels, unclearIds) => {
    state.rows = rows;
    mockTermPropertyLabels.mockResolvedValue(labels);
    const { body } = await invoke(getHandler());
    for (const term of body.terms) {
      const unclear = unclearIds.includes(term.id);
      expect(term.canDecline).toBe(!unclear);
      expect(Boolean(term.propertyUnclear)).toBe(unclear);
      if (unclear) expect(term.propertyLabel).toBeNull();
    }
  });

  // Codex r2 P1: an un-anchored original term's term_end is provisional —
  // the GET says so, so the card describes coverage relative to the
  // installation instead of quoting that date.
  test('an un-anchored original term reports awaitsInstallation:true; anchored and renewal terms do not', async () => {
    state.rows = [
      anchoredActive('term-anchored', '2027-05-20'),
      anchoredActive('term-provisional', '2027-06-01', { installation_anchored_at: null }),
      anchoredActive('term-renewal', '2027-07-01', { installation_anchored_at: null, renewed_from_term_id: 'term-0' }),
    ];
    mockTermPropertyLabels.mockResolvedValue(new Map([['term-anchored', 'A St'], ['term-provisional', 'B St'], ['term-renewal', 'C St']]));
    const { body } = await invoke(getHandler());
    expect(body.terms.map((term) => [term.id, term.awaitsInstallation])).toEqual([
      ['term-anchored', false], ['term-provisional', true], ['term-renewal', false],
    ]);
  });

  test('an already-declined term reports declined:true and canDecline:false', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'cancelled', renewal_decision: 'cancel',
    }];
    const { body } = await invoke(getHandler());
    expect(body.terms[0]).toEqual(expect.objectContaining({ declined: true, canDecline: false }));
    expect(mockIsPaidDecidedLapseTerm).toHaveBeenCalledWith(expect.objectContaining({ id: 'term-1' }), db);
  });

  // codex pre-push P1: the decidedLapse SQL branch is status-only — a
  // declined term whose invoice was later refunded or disputed still reads
  // 'cancelled' + 'cancel'. Every decided-lapse row must be re-checked
  // against isPaidDecidedLapseTerm (billing's own live-coverage test)
  // before ever being shown as covered.
  test.each(['refunded', 'disputed'])('a declined term whose invoice was later %s no longer shows as covered', async () => {
    state.rows = [{
      id: 'term-1', term_end: '2027-05-20', prepay_amount: '450.00', status: 'cancelled', renewal_decision: 'cancel',
    }];
    mockIsPaidDecidedLapseTerm.mockResolvedValue(false);
    const { body } = await invoke(getHandler());
    expect(body).toEqual({ available: false, reason: 'no_term' });
  });

  test('a refunded decided-lapse term drops out while a separate still-active term keeps showing (multi-property)', async () => {
    state.rows = [
      { id: 'term-refunded', term_end: '2027-05-20', prepay_amount: '450.00', status: 'cancelled', renewal_decision: 'cancel' },
      {
        id: 'term-b', term_end: '2027-08-01', prepay_amount: '600.00', status: 'active', renewal_decision: null,
        annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-06-01T12:00:00Z',
      },
    ];
    mockIsPaidDecidedLapseTerm.mockResolvedValue(false);
    const { body } = await invoke(getHandler());
    expect(body.available).toBe(true);
    expect(body.terms).toEqual([{
      id: 'term-b', propertyLabel: null, termEnd: '2027-08-01', awaitsInstallation: false, prepayAmount: 600, declined: false, canDecline: true,
    }]);
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
  const TERM_ID = '6f1c2b1e-2a4d-4c8e-9b7a-1d2e3f4a5b6c';
  const OTHER_TERM_ID = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
  const post = () => invoke(postHandler(), { body: { termId: TERM_ID } });

  // codex round-1 P1: the route now forwards a body-supplied termId (a
  // multi-property account picks WHICH overlapping term to decline) — but
  // the customer identity NEVER comes from the body, and the termId is only
  // ever a selector the SERVICE re-matches against customer_id =
  // req.customerId AND annual_plan_version NOT NULL, so it can never target
  // another customer's term.
  test('forwards the body termId, but the customerId always comes from req.customerId, never the body', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: OTHER_TERM_ID, termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    await invoke(postHandler(), { customerId: 'cust-1', body: { termId: OTHER_TERM_ID, customerId: 'cust-2' } });
    expect(mockDeclineTermiteAnnualRenewal).toHaveBeenCalledWith({ customerId: 'cust-1', termId: OTHER_TERM_ID });
  });

  // Codex r2 P2: termId is REQUIRED and must be a UUID — the route never
  // falls back to the service's "earliest current term" selector.
  test.each([
    ['missing', {}],
    ['empty', { termId: '' }],
    ['not a UUID', { termId: 'term-1' }],
    ['a non-string (object injection attempt)', { termId: { $ne: null } }],
    ['an array', { termId: [TERM_ID] }],
  ])('a %s termId is a 400 and never reaches the service', async (_label, body) => {
    const { statusCode, body: resBody } = await invoke(postHandler(), { body });
    expect(statusCode).toBe(400);
    expect(resBody).toEqual(expect.objectContaining({ available: false, reason: 'invalid_term' }));
    expect(mockDeclineTermiteAnnualRenewal).not.toHaveBeenCalled();
  });

  test('success: 200 with the service result', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    const { statusCode, body } = await post();
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      available: true, ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
  });

  test('idempotent replay: 200 with alreadyDeclined:true', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: true,
    });
    const { statusCode, body } = await post();
    expect(statusCode).toBe(200);
    expect(body.alreadyDeclined).toBe(true);
  });

  test('gate disabled: 404', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'disabled' });
    const { statusCode, body } = await post();
    expect(statusCode).toBe(404);
    expect(body).toEqual(expect.objectContaining({ available: false, ok: false, reason: 'disabled' }));
  });

  test('no eligible term: 404', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'no_term' });
    const { statusCode } = await post();
    expect(statusCode).toBe(404);
  });

  test('term already ended: 409', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'term_ended', termId: 'term-1', termEnd: '2026-01-01' });
    const { statusCode, body } = await post();
    expect(statusCode).toBe(409);
    expect(body).toEqual(expect.objectContaining({
      available: false, ok: false, reason: 'term_ended', termId: 'term-1', termEnd: '2026-01-01',
    }));
  });

  // Codex r3 P2: a replay on a declined term whose year was refunded or
  // disputed since — 409 with a machine-readable code the portal renders
  // without any "coverage continues" copy.
  test('not_covered (declined, then refunded/disputed): 409 with code not_covered', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'not_covered', termId: TERM_ID });
    const { statusCode, body } = await post();
    expect(statusCode).toBe(409);
    expect(body).toEqual(expect.objectContaining({ ok: false, code: 'not_covered', reason: 'not_covered' }));
    expect(body.error).not.toMatch(/continues/i);
  });

  test('conflicting decision already on file: 409', async () => {
    mockDeclineTermiteAnnualRenewal.mockResolvedValue({ ok: false, reason: 'already_decided', decision: 'renew', termId: 'term-1' });
    const { statusCode } = await post();
    expect(statusCode).toBe(409);
  });

  test('a thrown service error is passed to next(), not swallowed as a 200', async () => {
    mockDeclineTermiteAnnualRenewal.mockRejectedValue(new Error('db exploded'));
    await expect(post()).rejects.toThrow('db exploded');
  });
});
