process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// POST /api/estimates/:token/consumer-notice, the cta.consumerNotice block on GET /:token/data and the accept refusal on
// PUT /:token/accept (GATE_ESTIMATE_CONSUMER_NOTICE). The route decides eligibility and nothing else: the notice itself is
// the service's job (estimate-consumer-notice.test.js), so the issuer and the state reads are stubbed at the seam while the
// termite-line detection stays real.
// Invariants: gate off = generic 404 and no database read, /data carries nothing new and accept is unchanged; only an open,
// customer-viewable estimate WITH a termite line reaches the issuer; a staff preview never does; a refused accept writes
// nothing and runs nothing after the check.

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
const mockBlocksAccept = jest.fn();
jest.mock('../services/estimate-consumer-notice', () => ({
  ...jest.requireActual('../services/estimate-consumer-notice'),
  ensureEstimateConsumerNotice: (...args) => mockEnsure(...args),
  consumerNoticeCtaFor: (...args) => mockCtaFor(...args),
  consumerNoticeBlocksAccept: (...args) => mockBlocksAccept(...args),
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

const TERMITE_DATA = { result: { recurring: { services: [{ service: 'termite_bait', name: 'Termite Bait Stations', monthly: 40 }] }, oneTime: { items: [] } } };
const PEST_DATA = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', monthly: 50 }] }, oneTime: { items: [] } } };
let seq = 0;
function makeEstimate(overrides = {}) {
  seq += 1;
  return {
    id: `est-consumer-notice-${seq}`,
    token: `consumernoticetoken${seq}`,
    status: 'sent', sent_at: '2026-09-01T00:00:00.000Z', viewed_at: '2026-09-02T00:00:00.000Z',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    archived_at: null,
    customer_id: 'cust-1',
    customer_name: 'Pat Owner', customer_phone: '(941) 555-0100', customer_email: 'pat@example.com',
    address: '12 Test Lane, Bradenton, FL 34205',
    satellite_url: null, waveguard_tier: null, bill_by_invoice: false,
    monthly_total: 40, annual_total: 480, onetime_total: 0,
    estimate_data: TERMITE_DATA,
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
const post = (estimate, query = '') => call(`${estimate.token}/consumer-notice${query}`, { method: 'POST', estimate });
const data = (estimate) => call(`${estimate.token}/data`, { estimate });
const accept = (estimate) => call(`${estimate.token}/accept`, { method: 'PUT', estimate, body: {} });

const ORIGINAL_GATE = process.env.GATE_ESTIMATE_CONSUMER_NOTICE;
const gateOn = () => { process.env.GATE_ESTIMATE_CONSUMER_NOTICE = 'true'; };
beforeEach(() => {
  delete process.env.GATE_ESTIMATE_CONSUMER_NOTICE;
  dbWrites.length = 0;
  dbTables.length = 0;
  mockEnsure.mockReset().mockResolvedValue({ ok: true, status: 201, signingUrl: 'https://portal.example.test/contract/abc' });
  mockCtaFor.mockReset().mockResolvedValue({ state: 'none', canSign: true });
  mockBlocksAccept.mockReset().mockResolvedValue(true);
  db.mockClear();
  db.transaction.mockClear();
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_ESTIMATE_CONSUMER_NOTICE;
  else process.env.GATE_ESTIMATE_CONSUMER_NOTICE = ORIGINAL_GATE;
});

describe('POST /:token/consumer-notice', () => {
  test('gate off: the generic 404, no database read, no service call', async () => {
    const res = await post(makeEstimate());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Estimate not found' });
    expect(db).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test('gate on: an open estimate with a termite line gets the signing URL, no-store, and nothing is written here', async () => {
    gateOn();
    const estimate = makeEstimate();
    const res = await post(estimate);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ signingUrl: 'https://portal.example.test/contract/abc' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure.mock.calls[0][0].estimate).toMatchObject({ id: estimate.id });
    expect(dbWrites).toEqual([]);
  });

  test('a pest plan with a Bora-Care add-on is a termite estimate', async () => {
    gateOn();
    const withBora = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] }, oneTime: { items: [{ service: 'bora_care', name: 'Bora-Care Attic Treatment', price: 900 }] } } };
    const res = await post(makeEstimate({ estimate_data: withBora }));
    expect(res.status).toBe(201);
  });

  test('an existing notice answers 200 with the same shape', async () => {
    gateOn();
    mockEnsure.mockResolvedValue({ ok: true, status: 200, signingUrl: 'https://portal.example.test/contract/def' });
    const res = await post(makeEstimate());
    expect(res).toMatchObject({ status: 200, body: { signingUrl: 'https://portal.example.test/contract/def' } });
  });

  test('an estimate with no termite line is the generic 404 and never reaches the service', async () => {
    gateOn();
    const res = await post(makeEstimate({ estimate_data: PEST_DATA }));
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test.each([
    ['a draft', { status: 'draft' }],
    ['a scheduled send', { status: 'scheduled' }],
    ['an accepted estimate', { status: 'accepted' }],
    ['a declined estimate', { status: 'declined' }],
    ['an expired status', { status: 'expired' }],
    ['a past expiry date', { expires_at: '2020-01-01T00:00:00.000Z' }],
    ['an archived estimate', { archived_at: '2026-10-01T00:00:00.000Z' }],
  ])('%s is the generic 404 and never reaches the service', async (_label, overrides) => {
    gateOn();
    const res = await post(makeEstimate(overrides));
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(dbWrites).toEqual([]);
  });

  test('a staff preview tap is the generic 404', async () => {
    gateOn();
    const res = await post(makeEstimate(), '?adminPreview=1');
    expect(res.status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test('an unknown token is the generic 404', async () => {
    gateOn();
    const res = await call('unknowntoken1234567890/consumer-notice', { method: 'POST', estimate: undefined });
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  test.each([
    ['no account', 'no_account', 'Please call us.'],
    ['no representative', 'no_representative', 'Please call us and we will finish it with you.'],
    ['already signed', 'already_signed', 'Your consumer notice is already signed. Please reload the page.'],
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
      delete process.env.GATE_ESTIMATE_CONSUMER_NOTICE;
      const dark = o.skip({ body: {} });
      gateOn();
      const live = o.skip({ body: {} });
      delete process.env.GATE_ESTIMATE_CONSUMER_NOTICE;
      return dark === true && live === false;
    })());
    expect(flips.some((o) => o.max === 10 && o.windowMs === 60 * 60 * 1000)).toBe(true);
  });
});

// The pre-guard is mounted in server/index.js before the global /api limiter, so privacy headers and the dark gate's 404
// land ahead of it. The global limiter here is a stand-in that always answers 429.
describe('consumer-notice pre-guard (mounted before the global /api limiter)', () => {
  async function guarded(path, { method = 'POST' } = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', estimatePublicRouter.consumerNoticePreGuard);
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
    const guardAt = src.indexOf("app.use('/api/estimates', estimatePublicRoutes.consumerNoticePreGuard)");
    const limiterAt = src.indexOf("app.use('/api/', limiter)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(guardAt);
  });

  test('gate off: the generic 404 with the privacy headers, ahead of the limiter (never a 429)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await guarded('abcdefghijklmnopqrstu/consumer-notice');
      expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
      expectPrivacyHeaders(res);
    }
  });

  test('gate on: a limiter 429 still carries the privacy headers', async () => {
    gateOn();
    const res = await guarded('abcdefghijklmnopqrstu/consumer-notice');
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
    estimatePublicRouter.consumerNoticePreGuard({ method: 'GET', path: '/abcdefghijklmnopqrstu/consumer-notice' }, res, next);
    estimatePublicRouter.consumerNoticePreGuard({ method: 'POST', path: '/abcdefghijklmnopqrstu/change-request' }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.set).not.toHaveBeenCalled();
  });
});

describe('GET /:token/data cta.consumerNotice', () => {
  test('gate off: the payload carries nothing new and the service is not asked', async () => {
    const res = await data(makeEstimate());
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('consumerNotice');
    expect(mockCtaFor).not.toHaveBeenCalled();
  });

  test('gate on: an open estimate carries the service block', async () => {
    gateOn();
    mockCtaFor.mockResolvedValue({ state: 'awaiting', canSign: true });
    const res = await data(makeEstimate());
    expect(res.body.cta.consumerNotice).toEqual({ state: 'awaiting', canSign: true });
  });

  test('gate on: an estimate the service has nothing to say about leaves the key off', async () => {
    gateOn();
    mockCtaFor.mockResolvedValue(null);
    const res = await data(makeEstimate({ estimate_data: PEST_DATA }));
    expect(res.body.cta).not.toHaveProperty('consumerNotice');
  });

  test.each([
    ['an accepted estimate', { status: 'accepted' }],
    ['a declined estimate', { status: 'declined' }],
  ])('gate on: %s offers nothing', async (_label, overrides) => {
    gateOn();
    const res = await data(makeEstimate(overrides));
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('consumerNotice');
    expect(mockCtaFor).not.toHaveBeenCalled();
  });
});

describe('PUT /:token/accept consumer notice refusal', () => {
  const NOTICE_MESSAGE = 'Please sign the Florida consumer notice above before you accept.';

  test('gate on, notice not on file: 409 consumer_notice_required, and nothing after the check ran', async () => {
    gateOn();
    const estimate = makeEstimate();
    const res = await accept(estimate);
    expect(res).toMatchObject({ status: 409, body: { error: NOTICE_MESSAGE, code: 'consumer_notice_required' } });
    expect(mockBlocksAccept).toHaveBeenCalledTimes(1);
    expect(mockBlocksAccept.mock.calls[0][0]).toMatchObject({ id: estimate.id });
    // No write of any kind, no transaction, and the only tables read are the estimate lookups ahead of the check.
    expect(dbWrites).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(dbTables.filter((t) => t !== 'estimates')).toEqual([]);
  });

  test('gate on, notice on file: the check passes and the accept goes on past it', async () => {
    gateOn();
    mockBlocksAccept.mockResolvedValue(false);
    const res = await accept(makeEstimate());
    expect(mockBlocksAccept).toHaveBeenCalledTimes(1);
    expect(res.body?.code).not.toBe('consumer_notice_required');
    expect(res.body?.error).not.toBe(NOTICE_MESSAGE);
  });

  test('gate off: the check is not even asked (accept unchanged)', async () => {
    const res = await accept(makeEstimate());
    expect(mockBlocksAccept).not.toHaveBeenCalled();
    expect(res.body?.code).not.toBe('consumer_notice_required');
  });

  test('a read error in the check fails the accept closed', async () => {
    gateOn();
    mockBlocksAccept.mockRejectedValue(new Error('db down'));
    const res = await accept(makeEstimate());
    expect(res.status).toBe(500);
    expect(dbWrites).toEqual([]);
  });

  test('an already-accepted estimate (a retry) is never asked for the notice', async () => {
    gateOn();
    await accept(makeEstimate({ status: 'accepted' }));
    expect(mockBlocksAccept).not.toHaveBeenCalled();
  });

  test('a declined estimate keeps its own answer ahead of the notice', async () => {
    gateOn();
    const res = await accept(makeEstimate({ status: 'declined' }));
    expect(mockBlocksAccept).not.toHaveBeenCalled();
    expect(res.status).not.toBe(200);
    expect(res.body?.code).not.toBe('consumer_notice_required');
  });
});
