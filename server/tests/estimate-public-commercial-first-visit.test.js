process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// POST /api/estimates/:token/first-visit(/availability) and the cta.commercialFirstVisit block on GET /:token/data
// (GATE_COMMERCIAL_FIRST_VISIT). The routes decide that the token names an open estimate the customer is viewing and
// nothing else: the plan, the times and the booking are the service's job (commercial-first-visit.test.js), so the
// service is stubbed at its seam. Invariants: gate off = generic 404 and no database read, and /data carries nothing
// new; only an open, customer-viewable estimate reaches the service; a staff preview never does.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({ getCachedLookup: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockAvailability = jest.fn();
const mockBook = jest.fn();
const mockCtaFor = jest.fn();
jest.mock('../services/commercial-first-visit', () => ({
  firstVisitAvailability: (...args) => mockAvailability(...args),
  bookFirstVisit: (...args) => mockBook(...args),
  firstVisitCtaFor: (...args) => mockCtaFor(...args),
}));
// Every limiter becomes a pass-through (this suite posts more than the real hourly cap) and its options are kept
// so the gate-aware skip can be asserted directly.
const mockLimiterOptions = [];
jest.mock('express-rate-limit', () => (options) => {
  mockLimiterOptions.push(options);
  return (_req, _res, next) => next();
});

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let estimateRow;
const dbWrites = [];
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain), whereIn: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain), orWhere: jest.fn(() => chain), orWhereRaw: jest.fn(() => chain), leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain), orderBy: jest.fn(() => chain), orderByRaw: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    forUpdate: jest.fn(() => chain), forShare: jest.fn(() => chain), noWait: jest.fn(() => chain),
    update: jest.fn(async (...a) => { dbWrites.push(['update', a]); return 1; }),
    insert: jest.fn(async (...a) => { dbWrites.push(['insert', a]); return [1]; }),
  };
  return chain;
}
db.mockImplementation((table) => {
  const chain = chainFor(table === 'estimates' ? estimateRow : undefined);
  if (table === 'customers') chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  if (table === 'estimates') {
    chain.whereNot = jest.fn(() => { chain.first = jest.fn().mockResolvedValue(null); return chain; });
    chain.whereNotNull = jest.fn(() => chain);
  }
  return chain;
});
db.transaction = jest.fn(async (fn) => fn(db));

let seq = 0;
function makeEstimate(overrides = {}) {
  seq += 1;
  return {
    id: `est-first-visit-${seq}`,
    token: `firstvisittoken${seq}xyz`,
    status: 'sent', sent_at: '2026-09-01T00:00:00.000Z', viewed_at: '2026-09-02T00:00:00.000Z',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    archived_at: null,
    customer_id: 'cust-1',
    customer_name: 'Harbor Plaza Association', customer_phone: '(941) 555-0100', customer_email: 'office@example.com',
    address: '100 Sample Way, Bradenton, FL 34205',
    satellite_url: null, waveguard_tier: null, bill_by_invoice: false,
    monthly_total: 100, annual_total: 1200, onetime_total: 0,
    estimate_data: {
      proposal: { enabled: true, buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly' }] }] },
    },
    ...overrides,
  };
}

async function call(path, { method = 'GET', estimate, body } = {}) {
  estimateRow = estimate;
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/estimates/${path}`, {
      method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  } finally {
    server.close();
  }
}
const availability = (estimate, query = '') => call(`${estimate.token}/first-visit/availability${query}`, { method: 'POST', estimate });
const book = (estimate, body = { date: '2026-11-03', time: '09:00' }, query = '') => call(`${estimate.token}/first-visit${query}`, { method: 'POST', estimate, body });
const data = (estimate) => call(`${estimate.token}/data`, { estimate });

const ORIGINAL_GATE = process.env.GATE_COMMERCIAL_FIRST_VISIT;
const gateOn = () => { process.env.GATE_COMMERCIAL_FIRST_VISIT = 'true'; };
beforeEach(() => {
  delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
  dbWrites.length = 0;
  mockAvailability.mockReset().mockResolvedValue({ ok: true, days: [{ date: '2026-11-03', slots: [{ start_time: '09:00' }] }], slots: [], nearby: false, rangeFrom: '2026-10-27', rangeTo: '2026-11-09', durationMinutes: 30 });
  mockBook.mockReset().mockResolvedValue({ ok: true, visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } });
  mockCtaFor.mockReset().mockResolvedValue({ state: 'pick', durationMinutes: 30 });
  db.mockClear();
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
  else process.env.GATE_COMMERCIAL_FIRST_VISIT = ORIGINAL_GATE;
});


const NOT_OPEN = [
  ['a draft', { status: 'draft' }],
  ['an accepted estimate', { status: 'accepted' }],
  ['a declined estimate', { status: 'declined' }],
  ['an expired status', { status: 'expired' }],
  ['a past expiry date', { expires_at: '2020-01-01T00:00:00.000Z' }],
  ['an archived estimate', { archived_at: '2026-10-01T00:00:00.000Z' }],
];

describe('POST /:token/first-visit/availability', () => {
  test('gate off: the generic 404, no database read, no service call', async () => {
    const res = await availability(makeEstimate());
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(db).not.toHaveBeenCalled();
    expect(mockAvailability).not.toHaveBeenCalled();
  });

  test('gate on: an open estimate gets the service answer with no-store, and nothing is written here', async () => {
    gateOn();
    const estimate = makeEstimate();
    const res = await availability(estimate);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, durationMinutes: 30, days: [{ date: '2026-11-03' }] });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockAvailability.mock.calls[0][0]).toMatchObject({ id: estimate.id });
    expect(dbWrites).toEqual([]);
  });

  test.each(NOT_OPEN)('%s is the generic 404 and never reaches the service', async (_label, overrides) => {
    gateOn();
    const res = await availability(makeEstimate(overrides));
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockAvailability).not.toHaveBeenCalled();
  });

  test('a staff preview is the generic 404', async () => {
    gateOn();
    const res = await availability(makeEstimate(), '?adminPreview=1');
    expect(res.status).toBe(404);
    expect(mockAvailability).not.toHaveBeenCalled();
  });

  test('the service 404 stays the generic body, and its 409s pass through with their code', async () => {
    gateOn();
    mockAvailability.mockResolvedValue({ ok: false, status: 404, code: 'not_found', error: 'Estimate not found' });
    expect(await availability(makeEstimate())).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    mockAvailability.mockResolvedValue({ ok: false, status: 409, code: 'already_booked', error: 'Your first visit is already booked.', visit: { date: '2026-11-03' } });
    expect(await availability(makeEstimate())).toMatchObject({ status: 409, body: { code: 'already_booked', visit: { date: '2026-11-03' } } });
  });
});

describe('POST /:token/first-visit', () => {
  test('gate off: the generic 404, no database read, no booking', async () => {
    const res = await book(makeEstimate());
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(db).not.toHaveBeenCalled();
    expect(mockBook).not.toHaveBeenCalled();
  });

  test('gate on: books through the service with the trimmed body and the open-estimate verdict', async () => {
    gateOn();
    const estimate = makeEstimate();
    const res = await book(estimate, { date: ' 2026-11-03 ', time: '09:00 ' });
    expect(res).toMatchObject({ status: 200, body: { booked: true, visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } } });
    const [passed, opts] = mockBook.mock.calls[0];
    expect(passed).toMatchObject({ id: estimate.id });
    expect(opts).toMatchObject({ date: '2026-11-03', time: '09:00' });
    // The verdict the booking transaction re-runs on its fresh read.
    expect(opts.openFor(makeEstimate())).toBe(true);
    expect(opts.openFor(makeEstimate({ status: 'accepted' }))).toBe(false);
    expect(opts.openFor(makeEstimate({ archived_at: '2026-10-01T00:00:00.000Z' }))).toBe(false);
  });

  test.each(NOT_OPEN)('%s is the generic 404 and never books', async (_label, overrides) => {
    gateOn();
    const res = await book(makeEstimate(overrides));
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockBook).not.toHaveBeenCalled();
  });

  test('a staff preview tap never books', async () => {
    gateOn();
    const res = await book(makeEstimate(), undefined, '?adminPreview=1');
    expect(res.status).toBe(404);
    expect(mockBook).not.toHaveBeenCalled();
  });

  test.each([
    [409, 'slot_taken'], [409, 'estimate_changed'], [409, 'call_us'], [400, 'invalid'],
  ])('a service %i %s passes through with its code', async (status, code) => {
    gateOn();
    mockBook.mockResolvedValue({ ok: false, status, code, error: 'Message for the page.' });
    expect(await book(makeEstimate())).toMatchObject({ status, body: { code, error: 'Message for the page.' } });
  });
});

describe('commercial-first-visit pre-guard (mounted before the global /api limiter)', () => {
  test('server/index.js mounts the guard before the global /api/ limiter', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const guardAt = src.indexOf("app.use('/api/estimates', estimatePublicRoutes.commercialFirstVisitPreGuard)");
    const limiterAt = src.indexOf("app.use('/api/', limiter)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(guardAt);
  });

  test('gate off: both paths answer the generic 404 with the privacy headers; other paths pass through', () => {
    for (const path of ['/abcdefghijklmnopqrstu/first-visit', '/abcdefghijklmnopqrstu/first-visit/availability']) {
      const headers = {};
      const res = { set: jest.fn((k, v) => { headers[k] = v; }), status: jest.fn(() => res), json: jest.fn(() => res) };
      const next = jest.fn();
      estimatePublicRouter.commercialFirstVisitPreGuard({ method: 'POST', path }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(headers).toMatchObject({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    }
    const next = jest.fn();
    const res = { set: jest.fn() };
    estimatePublicRouter.commercialFirstVisitPreGuard({ method: 'GET', path: '/abcdefghijklmnopqrstu/first-visit' }, res, next);
    estimatePublicRouter.commercialFirstVisitPreGuard({ method: 'POST', path: '/abcdefghijklmnopqrstu/first-visit/other' }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.set).not.toHaveBeenCalled();
  });

  test('gate on: the guard stamps the headers and passes through', () => {
    gateOn();
    const res = { set: jest.fn() };
    const next = jest.fn();
    estimatePublicRouter.commercialFirstVisitPreGuard({ method: 'POST', path: '/abcdefghijklmnopqrstu/first-visit' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  test('both route limiters are skipped while the gate is dark and count once it is on', () => {
    const flips = mockLimiterOptions.filter((o) => typeof o?.skip === 'function' && (() => {
      delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
      const dark = o.skip({ body: {} });
      gateOn();
      const live = o.skip({ body: {} });
      delete process.env.GATE_COMMERCIAL_FIRST_VISIT;
      return dark === true && live === false;
    })());
    expect(flips.map((o) => `${o.max}/${o.windowMs}`).sort()).toEqual(['10/60000', '15/60000']);
  });
});

describe('GET /:token/data cta.commercialFirstVisit', () => {
  test('gate off: nothing new, and the service is not asked', async () => {
    const res = await data(makeEstimate());
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('commercialFirstVisit');
    expect(mockCtaFor).not.toHaveBeenCalled();
  });

  test('gate on: an open estimate the customer views is asked as open, and the block rides cta', async () => {
    gateOn();
    const res = await data(makeEstimate());
    expect(res.body.cta.commercialFirstVisit).toEqual({ state: 'pick', durationMinutes: 30 });
    expect(mockCtaFor.mock.calls[0][1]).toEqual({ open: true, picker: true });
  });

  test('gate on: an accepted estimate is asked as not open (only a booked visit can show)', async () => {
    gateOn();
    mockCtaFor.mockResolvedValue({ state: 'booked', visit: { date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00' } });
    const res = await data(makeEstimate({ status: 'accepted' }));
    expect(mockCtaFor.mock.calls[0][1]).toEqual({ open: false, picker: false });
    expect(res.body.cta.commercialFirstVisit).toMatchObject({ state: 'booked' });
  });

  test('gate on: a service with nothing to offer leaves the key off', async () => {
    gateOn();
    mockCtaFor.mockResolvedValue(null);
    const res = await data(makeEstimate());
    expect(res.body.cta).not.toHaveProperty('commercialFirstVisit');
  });
});
