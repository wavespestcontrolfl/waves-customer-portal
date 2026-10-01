process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GET /:token/data serves the acceptance terms (GATE_ESTIMATE_ACCEPTANCE_TERMS)
// in the estimate's SCOPE (owner ruling 2026-09-30, codex #5434 r1 P0): a
// recurring residential plan gets the 'plan' drawer — its Services line ends
// with the annual rate review sentence — plus the 'base' lines a one-time
// toggle swaps in; a rodent or one-time-only estimate gets the 'base'
// drawer and never reads the rate term. The accept route re-derives the same
// scope (estimate-public-accept-atomicity.test.js).
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateAcceptanceTerms'),
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
const acceptanceTerms = require('../services/acceptance-terms-text');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
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
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function estimateRow(overrides = {}) {
  return {
    id: 'est-terms-scope',
    token: 'acceptancetermsscopetoken',
    status: 'sent',
    sent_at: null,
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester',
    customer_phone: '(941) 555-0123',
    customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203',
    satellite_url: null,
    waveguard_tier: 'Bronze',
    bill_by_invoice: false,
    show_one_time_option: false,
    monthly_total: 60,
    annual_total: 720,
    onetime_total: 0,
    estimate_data: {
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }] },
        oneTime: { items: [], membershipFee: 0 },
      },
    },
    ...overrides,
  };
}

async function dataFor(row) {
  dbRows = { estimates: row };
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/estimates/${row.token}/data`);
    expect(res.status).toBe(200);
    return res.json();
  } finally {
    server.close();
  }
}

describe('GET /:token/data — acceptance terms scope', () => {
  beforeEach(() => { dbRows = {}; });

  test("a recurring residential pest plan is served the 'plan' drawer (rate review sentence) with the one-time lines beside it", async () => {
    const body = await dataFor(estimateRow());
    expect(body.acceptanceTerms).toEqual(acceptanceTerms.acceptanceTermsPayload('plan'));
    expect(body.acceptanceTerms.scope).toBe('plan');
    expect(body.acceptanceTerms.terms[0].text).toContain(acceptanceTerms.RATE_REVIEW_SENTENCE);
    expect(body.acceptanceTerms.oneTimeTerms[0].text).not.toContain(acceptanceTerms.RATE_REVIEW_SENTENCE);
  });

  test("pest + lawn (every service carries the plan terms) is 'plan' too", async () => {
    const base = estimateRow();
    const body = await dataFor(estimateRow({
      id: 'est-terms-pest-lawn', token: 'acceptancetermspestlawn',
      estimate_data: { result: { ...base.estimate_data.result, recurring: { discount: 0, services: [{ name: 'Pest Control', service: 'pest_control', mo: 60 }, { name: 'Lawn Care', service: 'lawn_care', mo: 85 }] } } },
    }));
    expect(body.acceptanceTerms.scope).toBe('plan');
  });

  test("a rodent-only estimate is served the 'base' drawer: no rate review sentence anywhere in the payload", async () => {
    const body = await dataFor(estimateRow({
      id: 'est-terms-rodent', token: 'acceptancetermsrodenttoken', monthly_total: 40, annual_total: 480,
      estimate_data: { result: { recurring: { discount: 0, services: [{ name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 40 }] }, oneTime: { items: [], membershipFee: 0 } } },
    }));
    expect(body.acceptanceTerms).toEqual(acceptanceTerms.acceptanceTermsPayload('base'));
    expect(JSON.stringify(body.acceptanceTerms)).not.toContain('Rates are reviewed');
    expect(body.acceptanceTerms).not.toHaveProperty('oneTimeTerms');
  });

  test("a one-time-only residential pest estimate is served the 'base' drawer", async () => {
    const body = await dataFor(estimateRow({
      id: 'est-terms-one-time', token: 'acceptancetermsonetimetoken', monthly_total: 0, annual_total: 0, onetime_total: 150,
      estimate_data: {
        sendSnapshot: { pricingBundle: { frequencies: [], anchorOneTimePrice: 150, source: 'send_snapshot_fixture' } },
        result: { recurring: { discount: 0, services: [] }, oneTime: { items: [{ service: 'pest_one_time', name: 'One-Time Pest Control', price: 150 }], membershipFee: 0 } },
      },
    }));
    expect(body.acceptanceTerms.scope).toBe('base');
    expect(JSON.stringify(body.acceptanceTerms)).not.toContain('Rates are reviewed');
  });

  test('the payload is absent when the gate is off (byte-identical response)', async () => {
    const gates = require('../config/feature-gates');
    gates.isEnabled.mockImplementationOnce(() => false).mockImplementation(() => false);
    try {
      const body = await dataFor(estimateRow({ id: 'est-terms-off', token: 'acceptancetermsgateofftoken' }));
      expect(body).not.toHaveProperty('acceptanceTerms');
    } finally {
      gates.isEnabled.mockImplementation((gate) => gate === 'estimateAcceptanceTerms');
    }
  });
});
