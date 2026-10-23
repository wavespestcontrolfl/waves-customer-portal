process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK: GET /:token/data carries `beforeYouBook` (the sections of the
// "Before you book" page that apply to this estimate, already trimmed) only with the gate on. With
// the gate off the response has no such key.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../services/estimate-proposal-billing', () => ({
  ...jest.requireActual('../services/estimate-proposal-billing'),
  resolveProposalBillingContext: jest.fn(async () => ({ billsPerApplication: true, livePricing: null })),
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateDocPdf'),
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
const { SECTIONS } = require('../services/estimate-before-you-book');

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
    first: jest.fn().mockResolvedValue(Array.isArray(result) ? result[0] : result),
    update: jest.fn(async () => 1),
    insert: jest.fn().mockResolvedValue([1]),
    // Awaiting a builder yields the rows (customer_properties is read as a list).
    then: Array.isArray(result) ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : undefined,
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function estimateRow({ services, overrides = {} }) {
  return {
    id: 'est-lawn-limits', token: 'lawnlimitstoken', status: 'sent', sent_at: null, viewed_at: null,
    customer_id: 'cust-synthetic-1',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null, category: 'RESIDENTIAL',
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Silver', bill_by_invoice: false,
    service_interest: 'Lawn',
    monthly_total: 42.3, annual_total: 507.6, onetime_total: 0,
    estimate_data: {
      result: { recurring: { services: services.map((s) => ({ service: s, name: s, visitsPerYear: 6 })) } },
      sendSnapshot: { pricingBundle: {
        combinedRecurring: { waveGuardDiscountPct: 0 },
        frequencies: [{
          key: 'quarterly', monthly: 42.3, annual: 507.6,
          perServiceTreatments: services.map((s) => ({ label: s, service: s, displayPrice: 56.4, visitsPerYear: 6, monthly: 42.3 })),
        }],
        oneTimeBreakdown: { items: [] },
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
const getData = (baseUrl) => fetch(`${baseUrl}/estimates/lawnlimitstoken/data`).then((r) => r.json());


afterEach(() => { delete process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK; delete process.env.GATE_PREPAY_REFUND_90_DAY; });

const keysOf = (body) => body.beforeYouBook.sections.map((s) => s.key);

describe('GET /:token/data - before you book (GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK)', () => {
  beforeEach(() => { dbRows = { estimates: estimateRow({ services: ['pest_control', 'lawn_care'] }), customers: { lawn_type: null }, customer_properties: [] }; });

  test('gate off: no beforeYouBook key, and the rest of the payload is the same as with the gate unset', async () => {
    await withServer(async (baseUrl) => {
      const unset = await getData(baseUrl);
      process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'false';
      const off = await getData(baseUrl);
      expect(off.estimate).toBeDefined();
      expect(off).not.toHaveProperty('beforeYouBook');
      // meta, cacheHit and the ask token (it carries a timestamp) change from one call to the next; everything else is the same.
      const stable = (body) => JSON.stringify(body, (key, value) => (key === 'meta' || key === 'cacheHit' || key === 'askToken' ? undefined : value));
      expect(stable(off)).toBe(stable(unset));
    });
  });

  test('gate on: the always-section plus pest and lawn, as plain strings with no prices', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.beforeYouBook.title).toBe('Before you book');
      expect(keysOf(body)).toEqual(['scheduling', 'pest', 'lawn']);
      for (const section of body.beforeYouBook.sections) {
        expect(typeof section.heading).toBe('string');
        for (const line of section.lines) expect(typeof line).toBe('string');
      }
      expect(JSON.stringify(body.beforeYouBook)).not.toMatch(/\$|\bsafe\b|\bEPA\b/i);
      // Every line is a line of the shared module's copy.
      const known = new Set(SECTIONS.flatMap((s) => s.lines.map((l) => l.text)));
      for (const section of body.beforeYouBook.sections) for (const line of section.lines) expect(known.has(line)).toBe(true);
    });
  });

  test('gate on, accepted or declined estimate: no key; a commercial single-building one has no no-contract line', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    for (const status of ['accepted', 'declined']) {
      dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'], overrides: { status } }) };
      await withServer(async (baseUrl) => {
        const body = await getData(baseUrl);
        expect(body.estimate).toBeDefined();
        expect(body).not.toHaveProperty('beforeYouBook');
      });
    }
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'], overrides: { expires_at: '2020-01-01T00:00:00.000Z' } }) };
    await withServer(async (baseUrl) => {
      expect(await getData(baseUrl)).not.toHaveProperty('beforeYouBook');
    });
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'], overrides: { category: 'COMMERCIAL' } }) };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.beforeYouBook).toBeDefined();
      const lines = body.beforeYouBook.sections.flatMap((s) => s.lines).join(' ');
      expect(lines).not.toContain('no long-term contract');
      expect(lines).toContain('follow the agreement you sign');
    });
  });

  test('the prepay refund line prints only when the payload itself offers annual prepay', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    process.env.GATE_PREPAY_REFUND_90_DAY = 'true';
    const refundLine = (body) => body.beforeYouBook.sections.flatMap((x) => x.lines).some((l) => l.includes('If you prepay for the year'));
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'] }) };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.pricing.annualPrepayEligible).toBe(true);
      expect(refundLine(body)).toBe(true);
    });
    // The pricing payload offers no prepay (a termite bond rider cannot prepay): the page does not mention a prepay refund.
    // A new id: the pricing bundle is cached per estimate id for a few minutes.
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control', 'termite_bond'], overrides: { id: 'est-byb-bond' } }) };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.pricing.annualPrepayEligible).toBe(false);
      expect(refundLine(body)).toBe(false);
    });
  });

  test('gate on, pest-only estimate: no lawn section', async () => {
    process.env.GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK = 'true';
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'] }) };
    await withServer(async (baseUrl) => {
      expect(keysOf(await getData(baseUrl))).toEqual(['scheduling', 'pest']);
    });
  });
});
