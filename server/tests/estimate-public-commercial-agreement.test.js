process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// POST /api/estimates/:token/commercial-agreement and the cta.commercialAgreement block on GET /:token/data
// (GATE_COMMERCIAL_PROPOSAL_SIGN). The route decides eligibility and nothing else: the agreement itself is the
// service's job (commercial-proposal-agreement.test.js), so the service is stubbed at its seam here.
// Invariants: gate off = generic 404 and no database read, and /data carries nothing new; only an open,
// customer-viewable estimate reaches the service; a staff preview never does; the estimate row is never written.

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
const mockEnsureAgreement = jest.fn();
const mockAgreementCtaFor = jest.fn();
jest.mock('../services/commercial-proposal-agreement', () => ({
  ensureAgreement: (...args) => mockEnsureAgreement(...args),
  agreementCtaFor: (...args) => mockAgreementCtaFor(...args),
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
    id: `est-commercial-sign-${seq}`,
    token: `commercialsigntoken${seq}`,
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

async function call(path, { method = 'GET', estimate } = {}) {
  estimateRow = estimate;
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/estimates/${path}`, { method });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  } finally {
    server.close();
  }
}
const post = (estimate, query = '') => call(`${estimate.token}/commercial-agreement${query}`, { method: 'POST', estimate });
const data = (estimate) => call(`${estimate.token}/data`, { estimate });

const ORIGINAL_GATE = process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
const gateOn = () => { process.env.GATE_COMMERCIAL_PROPOSAL_SIGN = 'true'; };
beforeEach(() => {
  delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
  dbWrites.length = 0;
  mockEnsureAgreement.mockReset().mockResolvedValue({ ok: true, status: 201, signingUrl: 'https://portal.example.test/contract/abc' });
  mockAgreementCtaFor.mockReset().mockResolvedValue({ canSign: true, state: 'none' });
  db.mockClear();
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
  else process.env.GATE_COMMERCIAL_PROPOSAL_SIGN = ORIGINAL_GATE;
});

describe('POST /:token/commercial-agreement', () => {
  test('gate off: the generic 404, no database read, no service call', async () => {
    const res = await post(makeEstimate());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Estimate not found' });
    expect(db).not.toHaveBeenCalled();
    expect(mockEnsureAgreement).not.toHaveBeenCalled();
  });

  test('gate on: an open viewable estimate gets the signing URL, no-store, and nothing is written here', async () => {
    gateOn();
    const estimate = makeEstimate();
    const res = await post(estimate);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ signingUrl: 'https://portal.example.test/contract/abc' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockEnsureAgreement).toHaveBeenCalledTimes(1);
    expect(mockEnsureAgreement.mock.calls[0][0].estimate).toMatchObject({ id: estimate.id });
    expect(dbWrites).toEqual([]);
  });

  test('an existing agreement answers 200 with the same shape', async () => {
    gateOn();
    mockEnsureAgreement.mockResolvedValue({ ok: true, status: 200, signingUrl: 'https://portal.example.test/contract/def' });
    const res = await post(makeEstimate());
    expect(res).toMatchObject({ status: 200, body: { signingUrl: 'https://portal.example.test/contract/def' } });
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
    expect(mockEnsureAgreement).not.toHaveBeenCalled();
    expect(dbWrites).toEqual([]);
  });

  test('a staff preview tap is the generic 404', async () => {
    gateOn();
    const res = await post(makeEstimate(), '?adminPreview=1');
    expect(res.status).toBe(404);
    expect(mockEnsureAgreement).not.toHaveBeenCalled();
  });

  test('an unknown token is the generic 404', async () => {
    gateOn();
    const res = await call('unknowntoken1234567890/commercial-agreement', { method: 'POST', estimate: undefined });
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
    expect(mockEnsureAgreement).not.toHaveBeenCalled();
  });

  test('the service refusal for an estimate with no customer account is a 409 the page can show', async () => {
    gateOn();
    mockEnsureAgreement.mockResolvedValue({ ok: false, status: 409, code: 'no_customer', error: 'Please call us and we will get you started.' });
    const res = await post(makeEstimate({ customer_id: null }));
    expect(res).toMatchObject({ status: 409, body: { code: 'no_customer', error: 'Please call us and we will get you started.' } });
  });

  test('the service not-found stays the generic body (no code leaks)', async () => {
    gateOn();
    mockEnsureAgreement.mockResolvedValue({ ok: false, status: 404, code: 'not_signable', error: 'Estimate not found' });
    const res = await post(makeEstimate());
    expect(res).toMatchObject({ status: 404, body: { error: 'Estimate not found' } });
  });

  test('the locked re-check handed to the service refuses a row that stopped being open', async () => {
    gateOn();
    await post(makeEstimate());
    const { blockedFor } = mockEnsureAgreement.mock.calls[0][0];
    const trx = jest.fn();
    expect(await blockedFor(trx, makeEstimate({ status: 'accepted' }))).toBe(true);
    expect(await blockedFor(trx, makeEstimate({ status: 'declined' }))).toBe(true);
    expect(await blockedFor(trx, makeEstimate({ archived_at: '2026-10-01T00:00:00.000Z' }))).toBe(true);
    expect(await blockedFor(trx, makeEstimate())).toBe(false);
  });

  test('the route limiter is skipped while the gate is dark (a probe never sees a 429) and counts once it is on', () => {
    const flips = mockLimiterOptions.filter((o) => typeof o?.skip === 'function' && (() => {
      delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
      const dark = o.skip({ body: {} });
      gateOn();
      const live = o.skip({ body: {} });
      delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
      return dark === true && live === false;
    })());
    expect(flips.some((o) => o.max === 10 && o.windowMs === 60 * 60 * 1000)).toBe(true);
  });
});

describe('GET /:token/data cta.commercialAgreement', () => {
  test('gate off: the payload carries nothing new and the service is not asked', async () => {
    const res = await data(makeEstimate());
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('commercialAgreement');
    expect(mockAgreementCtaFor).not.toHaveBeenCalled();
  });

  test('gate on: an open estimate carries the service block', async () => {
    gateOn();
    mockAgreementCtaFor.mockResolvedValue({ canSign: true, state: 'awaiting' });
    const res = await data(makeEstimate());
    expect(res.body.cta.commercialAgreement).toEqual({ canSign: true, state: 'awaiting' });
  });

  test('gate on: a service that has nothing to offer leaves the key off', async () => {
    gateOn();
    mockAgreementCtaFor.mockResolvedValue(null);
    const res = await data(makeEstimate());
    expect(res.body.cta).not.toHaveProperty('commercialAgreement');
  });

  test.each([
    ['an accepted estimate', { status: 'accepted' }],
    ['a declined estimate', { status: 'declined' }],
  ])('gate on: %s offers nothing', async (_label, overrides) => {
    gateOn();
    const res = await data(makeEstimate(overrides));
    expect(res.status).toBe(200);
    expect(res.body.cta).not.toHaveProperty('commercialAgreement');
    expect(mockAgreementCtaFor).not.toHaveBeenCalled();
  });
});
