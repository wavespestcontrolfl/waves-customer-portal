process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// B18 park: GET /:token/data reports the page's EXISTING review-before-booking state (cta.reviewBeforeBooking with
// reviewReason 'contact_review', canAccept false) for an open, unlinked estimate whose lone phone candidate it
// contradicts - and says nothing about the other customer. Every other estimate is exactly as before.

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

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let estimateRow;
let phoneCandidates;
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain), whereIn: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain), orWhere: jest.fn(() => chain), orWhereRaw: jest.fn(() => chain), leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain), orderBy: jest.fn(() => chain), orderByRaw: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
db.mockImplementation((table) => {
  if (table === 'customers') {
    // The phone sweep awaits the chain itself (a list); other customers reads end in .first().
    const c = chainFor(null);
    c.then = (resolve, reject) => Promise.resolve(phoneCandidates).then(resolve, reject);
    return c;
  }
  return chainFor(table === 'estimates' ? estimateRow : undefined);
});

const BOB = { id: 'cust-bob', first_name: 'Bob', last_name: 'Example', phone: '(941) 555-0123', email: 'bob@example.com', address_line1: '9 Other St' };
let tokenSeq = 0;
function makeEstimate(overrides = {}) {
  tokenSeq += 1;
  return {
    id: `est-parked-data-${tokenSeq}`,
    token: `parkeddatatoken${tokenSeq}`,
    status: 'sent', sent_at: null, viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_id: null,
    customer_name: 'Pat Tester', customer_phone: '(941) 555-0123', customer_email: 'pat@example.com',
    address: '123 Palm Ave, Bradenton, FL 34203',
    satellite_url: null, waveguard_tier: 'Bronze', bill_by_invoice: false,
    monthly_total: 88, annual_total: 1056, onetime_total: 0,
    estimate_data: {
      sendSnapshot: { pricingBundle: { frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }], waveGuardTier: 'Bronze', source: 'send_snapshot_fixture' } },
      result: { recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] }, oneTime: { items: [], membershipFee: 0 } },
    },
    ...overrides,
  };
}

async function getData(estimate) {
  estimateRow = estimate;
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/estimates/${estimate.token}/data`);
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}
const ctaOf = (r) => JSON.parse(r.text).cta;

beforeEach(() => { phoneCandidates = []; });

test('a contradicted lone phone candidate: the page gets the existing review state (no accept, no card step) and no word about the other customer', async () => {
  phoneCandidates = [BOB];
  const res = await getData(makeEstimate());
  expect(res.status).toBe(200);
  expect(ctaOf(res)).toMatchObject({ canAccept: false, reviewBeforeBooking: true, reviewReason: 'contact_review', terminalState: null });
  expect(res.text).not.toContain('cust-bob');
  expect(res.text).not.toContain('Bob Example');
});

test.each([
  ['the candidate agrees on email', () => ({ phoneCandidates: [{ ...BOB, email: 'pat@example.com' }], estimate: {} })],
  ['the candidate agrees on address', () => ({ phoneCandidates: [{ ...BOB, address_line1: '123 Palm Ave' }], estimate: {} })],
  ['no phone candidate', () => ({ phoneCandidates: [], estimate: {} })],
  ['several candidates', () => ({ phoneCandidates: [BOB, { ...BOB, id: 'cust-2', address_line1: '55 Pine Ct' }], estimate: {} })],
  ['the estimate is already linked to a customer', () => ({ phoneCandidates: [BOB], estimate: { customer_id: 'cust-9' } })],
  ['the estimate has no phone', () => ({ phoneCandidates: [BOB], estimate: { customer_phone: null } })],
])('control: %s - the page is as before (accept stays available)', async (_label, build) => {
  const { phoneCandidates: candidates, estimate } = build();
  phoneCandidates = candidates;
  const res = await getData(makeEstimate(estimate));
  expect(res.status).toBe(200);
  expect(ctaOf(res)).toMatchObject({ canAccept: true, reviewBeforeBooking: false, reviewReason: null });
});
