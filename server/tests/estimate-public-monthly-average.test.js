process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GATE_ESTIMATE_MONTHLY_AVERAGE (owner 2026-10-20): GET /:token/data carries
// `monthlyAverageEnabled` for the page and, on the document pass,
// `proposal.monthlyAverage` for the PDF. Both are ABSENT with the gate off, so
// the response is byte-identical to before.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
const mockGate = { on: true, months: false };
jest.mock('../services/estimate-proposal-billing', () => ({
  ...jest.requireActual('../services/estimate-proposal-billing'),
  resolveProposalBillingContext: jest.fn(async () => ({ billsPerApplication: true, livePricing: null })),
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateDocPdf' || (gate === 'estimateMonthlyAverage' && mockGate.on)
    || (gate === 'estimateApplicationMonths' && mockGate.months)),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn().mockResolvedValue(null),
}));
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

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotIn: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    // dbRows.__update(row): a per-test hook for the served-evidence write
    // (returns the affected-row count; may mutate dbRows to simulate a race).
    update: jest.fn(async () => (typeof dbRows.__update === 'function' ? dbRows.__update(result) : 1)),
    insert: jest.fn().mockResolvedValue([1]),
    then: undefined,
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));


function perApplicationRow(overrides = {}) {
  return {
    id: 'est-monthly-average', token: 'unitprojectiontoken', status: 'sent', sent_at: null, viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null, category: 'RESIDENTIAL',
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Silver', bill_by_invoice: false,
    service_interest: 'Lawn + Pest',
    monthly_total: 72.3, annual_total: 867.6, onetime_total: 99,
    estimate_data: {
      sendSnapshot: { pricingBundle: {
        combinedRecurring: { waveGuardDiscountPct: 0.1 },
        frequencies: [{
          key: 'quarterly', monthly: 72.3, annual: 867.6,
          perServiceTreatments: [
            { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 },
            { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 },
          ],
        }],
        oneTimeBreakdown: { items: [{ kind: 'charge', service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup' }] },
      } },
    },
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

describe('GET /:token/data — monthly average (GATE_ESTIMATE_MONTHLY_AVERAGE)', () => {
  beforeEach(() => { mockGate.on = true; mockGate.months = false; dbRows = { estimates: perApplicationRow() }; });

  test('document pass: the inputs reconcile to the stored monthly total', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      const body = await res.json();
      expect(body.documentRender).toBe(true);
      expect(body.proposal.monthlyAverage).toEqual({
        planMonthly: 72.3,
        credit: null,
        bundleDiscountPct: 0.1,
        oneTime: { amount: 99, setup: true },
      });
      expect(body.monthlyAverageEnabled).toBe(true);
    });
  });

  // GATE_ESTIMATE_APPLICATION_MONTHS (EST-2026-1185): the page switch rides
  // only beside the monthly average, absent otherwise.
  test('application months: the switch rides only with both gates on', async () => {
    mockGate.months = true;
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/estimates/unitprojectiontoken/data`)).json();
      expect(body.applicationMonthsEnabled).toBe(true);
    });
    mockGate.on = false;
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/estimates/unitprojectiontoken/data`)).json();
      expect(body).not.toHaveProperty('applicationMonthsEnabled');
    });
    mockGate.on = true;
    mockGate.months = false;
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/estimates/unitprojectiontoken/data`)).json();
      expect(body).not.toHaveProperty('applicationMonthsEnabled');
    });
  });

  // The PDF document reads the same switch from /data: the document pass (?mode=pdf) carries it
  // beside proposal.monthlyAverage when both gates are on, and neither otherwise.
  test('application months: the document pass carries the switch with both gates on and not otherwise', async () => {
    const pdf = async () => (await (await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`)).json());
    let baseUrl;
    mockGate.months = true;
    await withServer(async (url) => { baseUrl = url; const body = await pdf(); expect(body.documentRender).toBe(true); expect(body.applicationMonthsEnabled).toBe(true); expect(body.proposal).toHaveProperty('monthlyAverage'); });
    mockGate.months = false;
    await withServer(async (url) => { baseUrl = url; expect(await pdf()).not.toHaveProperty('applicationMonthsEnabled'); });
    mockGate.months = true;
    mockGate.on = false;
    await withServer(async (url) => { baseUrl = url; const body = await pdf(); expect(body).not.toHaveProperty('applicationMonthsEnabled'); expect(body.proposal).not.toHaveProperty('monthlyAverage'); });
  });

  test('gate off: neither key exists, the response is as before', async () => {
    mockGate.on = false;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      const body = await res.json();
      expect(body.documentRender).toBe(true);
      expect(body.proposal).not.toHaveProperty('monthlyAverage');
      expect(body).not.toHaveProperty('monthlyAverageEnabled');
    });
  });

  test('a stored total that does not match the lines withholds the document average', async () => {
    dbRows = { estimates: perApplicationRow({ monthly_total: 99 }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      const body = await res.json();
      expect(body.proposal).not.toHaveProperty('monthlyAverage');
    });
  });

  test('a wizard draft with the commercial marker never carries the average, whatever its category says', async () => {
    const base = perApplicationRow();
    dbRows = { estimates: perApplicationRow({ category: 'RESIDENTIAL', estimate_data: { ...base.estimate_data, commercialEstimatedPricing: true } }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      const body = await res.json();
      expect(body.proposal).not.toHaveProperty('monthlyAverage');
    });
  });

  test.each([
    ['accepted', { status: 'accepted' }],
    ['declined', { status: 'declined' }],
    ['quote_required (no commercial marker)', { status: 'quote_required' }],
  ])('a %s per-application estimate carries no average on the document pass, as the page and legacy page show none', async (_name, overrides) => {
    dbRows = { estimates: perApplicationRow(overrides) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      const body = await res.json();
      expect(body.documentRender).toBe(true);
      expect(body.proposal).not.toHaveProperty('monthlyAverage');
    });
  });

  test('a commercial estimate never carries the average', async () => {
    dbRows = { estimates: perApplicationRow({ category: 'COMMERCIAL' }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/unitprojectiontoken/data?mode=pdf`);
      const body = await res.json();
      expect(body.proposal).not.toHaveProperty('monthlyAverage');
    });
  });
});
