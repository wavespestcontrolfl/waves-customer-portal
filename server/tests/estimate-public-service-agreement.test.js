process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// POST /api/estimates/:token/service-agreement and the cta.serviceAgreements block on GET /:token/data
// (GATE_ESTIMATE_SERVICE_AGREEMENT). The route decides eligibility and nothing else: the agreement itself is the
// service's job (estimate-service-agreement.test.js), so the issuer and the state read are stubbed at the seam while the
// lane detection stays real.
// Invariants: gate off = generic 404 and no database read, /data carries nothing new; only an ACCEPTED, customer-viewable
// residential estimate whose plan carries the requested lane reaches the issuer; an open, declined, expired or archived
// estimate, a commercial estimate, an unknown lane and a staff preview never do.

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
const mockEnsure = jest.fn();
const mockCtaFor = jest.fn();
jest.mock('../services/estimate-service-agreement', () => ({
  ...jest.requireActual('../services/estimate-service-agreement'),
  ensureEstimateServiceAgreement: (...args) => mockEnsure(...args),
  serviceAgreementCtaFor: (...args) => mockCtaFor(...args),
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
const dbTables = [];
db.mockImplementation((table) => {
  dbTables.push(table);
  const chain = chainFor(table === 'estimates' ? estimateRow : undefined);
  if (table === 'customers') chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  if (table === 'estimates') {
    chain.whereNot = jest.fn(() => { chain.first = jest.fn().mockResolvedValue(null); return chain; });
    chain.whereNotNull = jest.fn(() => chain);
  }
  return chain;
});
db.transaction = jest.fn(async (fn) => fn(db));

const PEST_DATA = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', monthly: 50 }] }, oneTime: { items: [] } } };
const BUNDLE_DATA = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', monthly: 50 }, { service: 'lawn_care', name: 'Lawn Care', monthly: 90 }] }, oneTime: { items: [] } } };
const COMMERCIAL_DATA = { result: { recurring: { services: [{ service: 'commercial_pest', name: 'Commercial Pest Control', monthly: 150 }] }, oneTime: { items: [] } } };
const ONE_TIME_DATA = { result: { recurring: { services: [] }, oneTime: { items: [{ service: 'pest_cleanout', name: 'One-Time Cleanout', price: 250 }] } } };
let seq = 0;
function makeEstimate(overrides = {}) {
  seq += 1;
  return {
    id: `est-service-agreement-${seq}`,
    token: `serviceagreementtoken${seq}`,
    status: 'accepted', sent_at: '2026-09-01T00:00:00.000Z', viewed_at: '2026-09-02T00:00:00.000Z', accepted_at: '2026-09-03T00:00:00.000Z',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    archived_at: null,
    customer_id: 'cust-1',
    customer_name: 'Pat Owner', customer_phone: '(941) 555-0100', customer_email: 'pat@example.com',
    address: '12 Test Lane, Bradenton, FL 34205',
    satellite_url: null, waveguard_tier: null, bill_by_invoice: false,
    monthly_total: 50, annual_total: 600, onetime_total: 0,
    accepted_frequency_key: 'quarterly',
    estimate_data: PEST_DATA,
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
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  } finally {
    server.close();
  }
}
const post = (estimate, body = { lane: 'pest' }, query = '') => call(`${estimate.token}/service-agreement${query}`, { method: 'POST', estimate, body });
const data = (estimate) => call(`${estimate.token}/data`, { estimate });

const ORIGINAL_GATE = process.env.GATE_ESTIMATE_SERVICE_AGREEMENT;
const gateOn = () => { process.env.GATE_ESTIMATE_SERVICE_AGREEMENT = 'true'; };
const SIGNING_URL = 'https://portal.example.test/contract/abc';
beforeEach(() => {
  delete process.env.GATE_ESTIMATE_SERVICE_AGREEMENT;
  dbWrites.length = 0;
  dbTables.length = 0;
  mockEnsure.mockReset().mockResolvedValue({ ok: true, status: 201, signingUrl: SIGNING_URL });
  mockCtaFor.mockReset().mockResolvedValue([{ lane: 'pest', title: 'Residential Pest Service Agreement', state: 'none', canSign: true }]);
  db.mockClear();
  db.transaction.mockClear();
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_ESTIMATE_SERVICE_AGREEMENT;
  else process.env.GATE_ESTIMATE_SERVICE_AGREEMENT = ORIGINAL_GATE;
});

describe('POST /:token/service-agreement', () => {
  test('gate off: the generic 404, no database read, no service call', async () => {
    const res = await post(makeEstimate());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Estimate not found' });
    expect(db).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test('gate on: an accepted pest plan gets the signing URL for its lane, no-store, and nothing is written here', async () => {
    gateOn();
    const estimate = makeEstimate();
    const res = await post(estimate);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ signingUrl: SIGNING_URL });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure.mock.calls[0][0]).toMatchObject({ estimate: { id: estimate.id }, lane: 'pest' });
    expect(typeof mockEnsure.mock.calls[0][0].blockedFor).toBe('function');
    expect(dbWrites).toEqual([]);
  });

  test('a pest + lawn bundle reaches the issuer for either lane', async () => {
    gateOn();
    expect((await post(makeEstimate({ estimate_data: BUNDLE_DATA }), { lane: 'lawn' })).status).toBe(201);
    expect(mockEnsure.mock.calls[0][0].lane).toBe('lawn');
    expect((await post(makeEstimate({ estimate_data: BUNDLE_DATA }), { lane: 'pest' })).status).toBe(201);
  });

  test('an existing agreement answers 200 with the same shape', async () => {
    gateOn();
    mockEnsure.mockResolvedValue({ ok: true, status: 200, signingUrl: 'https://portal.example.test/contract/def' });
    const res = await post(makeEstimate());
    expect(res).toMatchObject({ status: 200, body: { signingUrl: 'https://portal.example.test/contract/def' } });
  });

  test.each([
    ['a lane the plan does not carry', makeEstimate(), { lane: 'lawn' }],
    ['an unknown lane', makeEstimate(), { lane: 'termite' }],
    ['no lane', makeEstimate(), {}],
    ['a commercial estimate', makeEstimate({ estimate_data: COMMERCIAL_DATA }), { lane: 'pest' }],
    ['a one-time-only estimate', makeEstimate({ estimate_data: ONE_TIME_DATA }), { lane: 'pest' }],
  ])('%s is the generic 404 and never reaches the service', async (_label, estimate, body) => {
    gateOn();
    const res = await post(estimate, body);
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test.each([
    ['an open (sent) estimate', { status: 'sent' }],
    ['a viewed estimate', { status: 'viewed' }],
    ['a draft', { status: 'draft' }],
    ['a declined estimate', { status: 'declined' }],
    ['an expired status', { status: 'expired' }],
    ['an archived estimate', { archived_at: '2026-10-01T00:00:00.000Z' }],
  ])('%s is the generic 404 and never reaches the service', async (_label, overrides) => {
    gateOn();
    const res = await post(makeEstimate(overrides));
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(dbWrites).toEqual([]);
  });

  test('the issuer\'s own re-check refuses a row that is no longer accepted under lock', async () => {
    gateOn();
    await post(makeEstimate());
    const { blockedFor } = mockEnsure.mock.calls[0][0];
    expect(await blockedFor(db, makeEstimate())).toBe(false);
    expect(await blockedFor(db, makeEstimate({ status: 'sent' }))).toBe(true);
    expect(await blockedFor(db, makeEstimate({ status: 'declined' }))).toBe(true);
    expect(await blockedFor(db, makeEstimate({ archived_at: '2026-10-01T00:00:00.000Z' }))).toBe(true);
  });

  test('the issuer\'s re-check also re-runs the call-side verdict and live linkage on the locked row', async () => {
    gateOn();
    await post(makeEstimate());
    const { blockedFor } = mockEnsure.mock.calls[0][0];
    const withEngine = (estimatorEngine) => makeEstimate({ estimate_data: { ...PEST_DATA, estimatorEngine } });
    // A linkage correction that landed (or is queued) while the tap waited on the locks.
    expect(await blockedFor(db, withEngine({ linkage_invalidated_at: '2026-10-25T12:00:00.000Z' }))).toBe(true);
    expect(await blockedFor(db, withEngine({ invalidation_pending_at: '2026-10-25T12:00:00.000Z' }))).toBe(true);
    // The durable call verdict is read through the issuing transaction, and an unreadable verdict fails closed.
    const trxTables = [];
    const trx = jest.fn((table) => {
      trxTables.push(table);
      const chain = chainFor(undefined);
      if (table === 'call_log') chain.first = jest.fn().mockRejectedValue(Object.assign(new Error('read failed'), { code: 'ECONNRESET' }));
      return chain;
    });
    expect(await blockedFor(trx, withEngine({ callLogId: 'call-1' }))).toBe(true);
    expect(trxTables).toContain('call_log');
  });

  test('a staff preview tap is the generic 404', async () => {
    gateOn();
    const res = await post(makeEstimate(), { lane: 'pest' }, '?adminPreview=1');
    expect(res.status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test('an unknown token is the generic 404', async () => {
    gateOn();
    const res = await call('unknowntoken1234567890/service-agreement', { method: 'POST', estimate: undefined, body: { lane: 'pest' } });
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test.each([
    ['no account', 'no_account', 'Please call us.'],
    ['already signed', 'already_signed', 'Your service agreement is already signed. Please reload the page.'],
    ['agreement unavailable', 'template_unavailable', 'Please call us and we will finish it with you.'],
  ])('the service refusal for %s is a 409 the page can show', async (_label, code, error) => {
    gateOn();
    mockEnsure.mockResolvedValue({ ok: false, status: 409, code, error });
    const res = await post(makeEstimate());
    expect(res).toMatchObject({ status: 409, body: { code, error } });
  });

  test('the service not-found stays the generic body (no code leaks)', async () => {
    gateOn();
    mockEnsure.mockResolvedValue({ ok: false, status: 404, code: 'not_available', error: 'Estimate not found' });
    const res = await post(makeEstimate());
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
  });

  test('the route limiter is skipped while the gate is dark (a probe never sees a 429) and counts once it is on', () => {
    const flips = mockLimiterOptions.filter((o) => typeof o?.skip === 'function' && (() => {
      delete process.env.GATE_ESTIMATE_SERVICE_AGREEMENT;
      const dark = o.skip({ body: {} });
      gateOn();
      const live = o.skip({ body: {} });
      delete process.env.GATE_ESTIMATE_SERVICE_AGREEMENT;
      return dark === true && live === false;
    })());
    expect(flips.some((o) => o.max === 10 && o.windowMs === 60 * 60 * 1000)).toBe(true);
  });
});

// The pre-guard is mounted in server/index.js before the global /api limiter, so privacy headers and the dark gate's 404
// land ahead of it. The global limiter here is a stand-in that always answers 429.
describe('service-agreement pre-guard (mounted before the global /api limiter)', () => {
  async function guarded(path, { method = 'POST' } = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', estimatePublicRouter.serviceAgreementPreGuard);
    app.use('/api/', (_req, res) => res.status(429).json({ error: 'Too many requests' }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/estimates/${path}`, { method });
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    } finally {
      server.close();
    }
  }
  const expectPrivacyHeaders = (res) => {
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  };

  test('server/index.js mounts the guard before the global /api/ limiter', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const guardAt = src.indexOf("app.use('/api/estimates', estimatePublicRoutes.serviceAgreementPreGuard)");
    const limiterAt = src.indexOf("app.use('/api/', limiter)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(guardAt);
  });

  test('gate off: the generic 404 with the privacy headers, ahead of the limiter (never a 429)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await guarded('abcdefghijklmnopqrstu/service-agreement');
      expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
      expectPrivacyHeaders(res);
    }
  });

  test('gate on: a limiter 429 still carries the privacy headers', async () => {
    gateOn();
    const res = await guarded('abcdefghijklmnopqrstu/service-agreement');
    expect(res.status).toBe(429);
    expectPrivacyHeaders(res);
  });

  test('the handler stamps the headers itself too (correct without the mount)', async () => {
    gateOn();
    expectPrivacyHeaders(await post(makeEstimate()));
  });

  test('other routes and methods pass through untouched', () => {
    gateOn();
    const next = jest.fn();
    const res = { set: jest.fn() };
    estimatePublicRouter.serviceAgreementPreGuard({ method: 'GET', path: '/abcdefghijklmnopqrstu/service-agreement' }, res, next);
    estimatePublicRouter.serviceAgreementPreGuard({ method: 'POST', path: '/abcdefghijklmnopqrstu/consumer-notice' }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.set).not.toHaveBeenCalled();
  });
});

describe('GET /:token/data cta.serviceAgreements', () => {
  test('gate off: the payload carries nothing new and the service is not asked', async () => {
    const res = await data(makeEstimate());
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('serviceAgreements');
    expect(mockCtaFor).not.toHaveBeenCalled();
  });

  test('gate on: an accepted estimate carries the service block', async () => {
    gateOn();
    const block = [{ lane: 'pest', title: 'Residential Pest Service Agreement', state: 'awaiting', canSign: true }];
    mockCtaFor.mockResolvedValue(block);
    const res = await data(makeEstimate());
    expect(res.status).toBe(200);
    expect(res.body.cta.terminalState).toBe('accepted');
    expect(res.body.cta.serviceAgreements).toEqual(block);
  });

  test('gate on: an estimate the service has nothing to say about leaves the key off', async () => {
    gateOn();
    mockCtaFor.mockResolvedValue(null);
    const res = await data(makeEstimate({ estimate_data: ONE_TIME_DATA }));
    expect(res.body.cta).not.toHaveProperty('serviceAgreements');
  });

  test.each([
    ['an open estimate', { status: 'sent' }],
    ['a declined estimate', { status: 'declined' }],
  ])('gate on: %s offers nothing (the agreement comes after acceptance)', async (_label, overrides) => {
    gateOn();
    const res = await data(makeEstimate(overrides));
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('serviceAgreements');
    expect(mockCtaFor).not.toHaveBeenCalled();
  });
});
