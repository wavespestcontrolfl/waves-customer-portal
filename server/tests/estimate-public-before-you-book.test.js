process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GET /:token/data carries `beforeYouBook` (the sections of the "Before you book" page that apply to
// this estimate, already trimmed) on an open estimate, and no such key on a decided one.
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



const keysOf = (body) => body.beforeYouBook.sections.map((s) => s.key);

describe('GET /:token/data - before you book', () => {
  beforeEach(() => { dbRows = { estimates: estimateRow({ services: ['pest_control', 'lawn_care'] }), customers: { lawn_type: null }, customer_properties: [] }; });

  test('every section, as plain strings with no prices', async () => {
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.beforeYouBook.title).toBe('Before you book');
      expect(keysOf(body)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
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

  test('accepted or declined estimate: no key; a commercial-category one has no no-contract line', async () => {
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
      // The COMMERCIAL category without an authored proposal keeps the current page (owner 2026-10-24).
      expect(body.beforeYouBook.title).toBe('Before you book');
      expect(keysOf(body)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
    });
  });

  test('the conditional prepay refund line prints on any open estimate, not on a payload verdict (Codex #6504 r4)', async () => {
    const refundLine = (body) => body.beforeYouBook.sections.flatMap((x) => x.lines).some((l) => l.includes('If your estimate offers a prepaid year'));
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'] }) };
    await withServer(async (baseUrl) => { expect(refundLine(await getData(baseUrl))).toBe(true); });
  });

  test('pest-only estimate: the same sections (service sections are worded "if your estimate includes")', async () => {
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'] }) };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(keysOf(body)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
      expect(body.beforeYouBook.sections[2].heading).toBe('If your estimate includes a lawn plan');
    });
  });
});
