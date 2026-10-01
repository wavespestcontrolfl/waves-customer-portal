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

  // PR-B (GATE_PAF_EXISTING_CUSTOMERS): the resolver marks an existing customer
  // it moved onto the rail with afterVisitCard; /data surfaces two client
  // flags, each ABSENT otherwise so gate-off payloads stay byte-identical.
  test('PR-B: afterVisitExisting for a moved customer on the rail, afterVisitConsent only when a card is captured', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    const captured = await policyFor({ enforced: true, required: true, exemptReason: null, afterVisitCard: true });
    expect(captured.afterVisitExisting).toBe(true);
    expect(captured.afterVisitConsent).toBe(true);
    const saved = await policyFor({ enforced: true, required: false, exemptReason: 'saved_method_consented', afterVisitCard: true });
    expect(saved.afterVisitExisting).toBe(true);
    expect(saved).not.toHaveProperty('afterVisitConsent');
    // The paused cohort rides the same flags (card kept, pay link after the visit).
    const paused = await policyFor({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, autopayPaused: true });
    expect(paused.afterVisitExisting).toBe(true);
  });

  test('PR-B: a new customer on the rail and every exempt customer carry neither flag', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    for (const policy of [
      CAPTURE,
      { enforced: true, required: false, exemptReason: 'saved_method_consented' },
      { enforced: true, required: false, exemptReason: 'autopay_already_active' },
      { enforced: true, required: false, exemptReason: 'existing_plan_customer' },
      { enforced: true, required: false, exemptReason: 'autopay_paused' },
      { enforced: true, required: false, exemptReason: 'payer_billed' },
    ]) {
      const p = await policyFor(policy);
      expect(p).not.toHaveProperty('afterVisitExisting');
      expect(p).not.toHaveProperty('afterVisitConsent');
    }
  });

  test('PR-B: gate off (resolver returns today\'s policy) leaves the payload byte-identical', async () => {
    const p = await policyFor({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
    expect(Object.keys(p).sort()).toEqual(['enforced', 'exemptReason', 'prepayInLane', 'required']);
  });
});
