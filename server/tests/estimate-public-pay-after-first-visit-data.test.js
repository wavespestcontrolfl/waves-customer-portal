process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GET /:token/data — recurringCardPolicy.payAfterFirstVisit (GATE_PAY_AFTER_FIRST_VISIT,
// owner ruling 2026-09-30). PR-A plumbing: the flag is true only when the
// master gate is on AND the card lane is on AND the resolved policy puts this
// customer on the card rail; it is ABSENT otherwise so every gate-off response
// stays byte-identical. No client reads it yet.
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
jest.mock('../services/recurring-card-on-file', () => {
  const actual = jest.requireActual('../services/recurring-card-on-file');
  return { ...actual, resolveRecurringCardPolicyForEstimate: jest.fn() };
});
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
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function estimateRow(overrides = {}) {
  return {
    id: 'est-noguarantee-1',
    token: 'noguaranteetoken',
    status: 'sent',
    sent_at: null,
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester',
    customer_phone: null,
    customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203',
    satellite_url: null,
    waveguard_tier: 'Bronze',
    bill_by_invoice: false,
    monthly_total: 88,
    annual_total: 1056,
    onetime_total: 125,
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
          waveGuardTier: 'Bronze',
          anchorOneTimePrice: 125,
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
        oneTime: { items: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 125 }], membershipFee: 0 },
      },
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

const RecurringCards = require('../services/recurring-card-on-file');

describe('GET /:token/data — recurringCardPolicy.payAfterFirstVisit', () => {
  beforeEach(() => {
    dbRows = {};
    process.env.RECURRING_CARD_ON_FILE = 'true';
    delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
  });
  afterEach(() => {
    delete process.env.RECURRING_CARD_ON_FILE;
    delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
  });

  async function policyFor(policy) {
    RecurringCards.resolveRecurringCardPolicyForEstimate.mockResolvedValue(policy);
    const row = estimateRow({ id: 'est-paf-1', token: 'payafterfirsttoken' });
    dbRows = { estimates: row };
    return withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data`);
      expect(res.status).toBe(200);
      return (await res.json()).recurringCardPolicy;
    });
  }

  const CAPTURE = { enforced: true, required: true, exemptReason: null };

  test('gate off: the key is absent for a customer on the card rail (byte-identical payload)', async () => {
    const p = await policyFor(CAPTURE);
    expect(p.required).toBe(true);
    expect(p).not.toHaveProperty('payAfterFirstVisit');
  });

  test('gate on: true for a capture-required customer and for already-enrolled customers', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    expect((await policyFor(CAPTURE)).payAfterFirstVisit).toBe(true);
    expect((await policyFor({ enforced: true, required: false, exemptReason: 'saved_method_consented' })).payAfterFirstVisit).toBe(true);
    expect((await policyFor({ enforced: true, required: false, exemptReason: 'autopay_already_active' })).payAfterFirstVisit).toBe(true);
  });

  test('gate on: every exempt customer stays off the flag', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    for (const exemptReason of [
      'existing_plan_customer', 'autopay_paused', 'payer_billed', 'payer_check_uncertain',
      'invoice_mode', 'prepay_annual', 'commercial_manual_billing', 'one_time_card_hold_lane',
    ]) {
      const p = await policyFor({ enforced: true, required: false, exemptReason });
      expect(p).not.toHaveProperty('payAfterFirstVisit');
    }
  });

  test('gate on but the card lane is off: no flag', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    delete process.env.RECURRING_CARD_ON_FILE;
    const p = await policyFor({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    expect(p).not.toHaveProperty('payAfterFirstVisit');
  });
});

// GATE_PAF_SETUP_FEE (pay-after-first-visit PR-C): the setup-only (monthly-tier)
// shape's fee is stamped on the first visit instead of invoiced at accept. The
// client applies its "setup fee billed with your first visit" copy and the
// after-visit consent text only when this flag is true (and its own selection
// resolves to that shape).
describe('GET /:token/data — recurringCardPolicy.setupFeeAfterFirstVisit', () => {
  beforeEach(() => {
    dbRows = {};
    process.env.RECURRING_CARD_ON_FILE = 'true';
    delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
    delete process.env.GATE_PAF_SETUP_FEE;
  });
  afterEach(() => {
    delete process.env.RECURRING_CARD_ON_FILE;
    delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
    delete process.env.GATE_PAF_SETUP_FEE;
  });

  // A monthly-billed tier row (mosquito ladder shape). The flag also requires
  // a known visit count: the accept defers only onto a priced first visit.
  const tierRow = (extra = {}) => estimateRow({
    id: 'est-paf-setup',
    token: 'payaftersetuptoken',
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'monthly12', label: 'Monthly', monthly: 88, annual: 1056, billingFrequencyKey: 'monthly', ...extra }],
          waveGuardTier: 'Bronze',
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ service: 'mosquito', name: 'Mosquito Control', mo: 88 }] },
        oneTime: { items: [], membershipFee: 99 },
      },
    },
  });

  async function policyFor(policy, rowExtra = { visitsPerYear: 12 }) {
    RecurringCards.resolveRecurringCardPolicyForEstimate.mockResolvedValue(policy);
    const row = tierRow(rowExtra);
    dbRows = { estimates: row };
    return withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data`);
      expect(res.status).toBe(200);
      return (await res.json()).recurringCardPolicy;
    });
  }

  const CAPTURE = { enforced: true, required: true, exemptReason: null };

  test('master gate on, sub-gate off: the key is absent (payload only gains payAfterFirstVisit)', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    const p = await policyFor(CAPTURE);
    expect(p.payAfterFirstVisit).toBe(true);
    expect(p).not.toHaveProperty('setupFeeAfterFirstVisit');
  });

  test('both gates on but the monthly tier\'s visit count is unknown: absent (the accept keeps the payable setup invoice there, so the page must not promise otherwise)', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    process.env.GATE_PAF_SETUP_FEE = 'true';
    const p = await policyFor(CAPTURE, {});
    expect(p.payAfterFirstVisit).toBe(true);
    expect(p).not.toHaveProperty('setupFeeAfterFirstVisit');
  });

  test('both gates on but no monthly-billed tier row at all (a pest cadence): absent', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    process.env.GATE_PAF_SETUP_FEE = 'true';
    RecurringCards.resolveRecurringCardPolicyForEstimate.mockResolvedValue(CAPTURE);
    const row = estimateRow({ id: 'est-paf-pest', token: 'payafterpesttoken' });
    dbRows = { estimates: row };
    const p = await withServer(async (baseUrl) => (await (await fetch(`${baseUrl}/estimates/${row.token}/data`)).json()).recurringCardPolicy);
    expect(p).not.toHaveProperty('setupFeeAfterFirstVisit');
  });

  test('sub-gate on without the master gate: absent', async () => {
    process.env.GATE_PAF_SETUP_FEE = 'true';
    expect(await policyFor(CAPTURE)).not.toHaveProperty('setupFeeAfterFirstVisit');
  });

  test('both gates on: every exempt customer stays off the flag', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    process.env.GATE_PAF_SETUP_FEE = 'true';
    for (const exemptReason of ['existing_plan_customer', 'autopay_paused', 'payer_billed', 'invoice_mode', 'commercial_manual_billing']) {
      expect(await policyFor({ enforced: true, required: false, exemptReason })).not.toHaveProperty('setupFeeAfterFirstVisit');
    }
  });

  // The positive composition (gates + card rail + resolvable tier visit counts)
  // is pinned at its seams: the rail predicate is the one payAfterFirstVisit
  // already proves above, and the tier-visit-count rule is this pure helper.
  test('monthlyTierVisitCountsResolvable: every monthly-billed tier row needs a positive visit count; no tier row at all is false', () => {
    const { monthlyTierVisitCountsResolvable } = estimatePublicRouter;
    const row = (extra = {}) => ({ key: 'monthly12', billingFrequencyKey: 'monthly', ...extra });
    expect(monthlyTierVisitCountsResolvable([row({ visitsPerYear: 12 })])).toBe(true);
    expect(monthlyTierVisitCountsResolvable([row({ visitsPerYear: 12 }), row({ key: 'seasonal9', visitsPerYear: 9 })])).toBe(true);
    expect(monthlyTierVisitCountsResolvable([row()])).toBe(false);
    expect(monthlyTierVisitCountsResolvable([row({ visitsPerYear: 0 })])).toBe(false);
    expect(monthlyTierVisitCountsResolvable([row({ visitsPerYear: 12 }), row({ key: 'seasonal9' })])).toBe(false);
    // Non-tier (pest cadence) rows never qualify.
    expect(monthlyTierVisitCountsResolvable([{ key: 'quarterly', visitsPerYear: 4 }])).toBe(false);
    expect(monthlyTierVisitCountsResolvable([])).toBe(false);
    expect(monthlyTierVisitCountsResolvable(null)).toBe(false);
  });
});
