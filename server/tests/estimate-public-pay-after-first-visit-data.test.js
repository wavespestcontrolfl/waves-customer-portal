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

  async function policyFor(policy, rowOverrides = {}) {
    RecurringCards.resolveRecurringCardPolicyForEstimate.mockResolvedValue(policy);
    const row = estimateRow({ id: 'est-paf-1', token: 'payafterfirsttoken', ...rowOverrides });
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
    // The paused cohort (owner R5: card kept, never auto-charged, pay link after
    // the visit) is on the rail but must NOT be shown the charged-after-the-
    // visit authorization or copy: afterVisitPaused instead of afterVisitConsent.
    const paused = await policyFor({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, autopayPaused: true });
    expect(paused.afterVisitExisting).toBe(true);
    expect(paused.afterVisitPaused).toBe(true);
    expect(paused).not.toHaveProperty('afterVisitConsent');
    expect(captured).not.toHaveProperty('afterVisitPaused');
  });

  // Explicit Auto Pay opt-out: held like the pause (card kept, never enrolled or
  // charged, pay link after the visit), but with its own flag so the client copy
  // never claims the plan is "paused".
  test('PR-B: explicit Auto Pay opt-out surfaces afterVisitAutopayOff, never afterVisitConsent / afterVisitPaused', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    const off = await policyFor({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, autopayDisabled: true });
    expect(off.afterVisitExisting).toBe(true);
    expect(off.afterVisitAutopayOff).toBe(true);
    expect(off).not.toHaveProperty('afterVisitConsent');
    expect(off).not.toHaveProperty('afterVisitPaused');
    const plain = await policyFor({ enforced: true, required: true, exemptReason: null, afterVisitCard: true });
    expect(plain).not.toHaveProperty('afterVisitAutopayOff');
  });

  // GitHub Codex #5481 r1: /data resolves with no payment preference, so the
  // PR-B widening puts the cohort on the rail here, but an annual-prepay accept
  // resolves them exactly as today (never in-lane) — prepayInLane must stay false.
  test('PR-B: prepayInLane is never advertised to the moved existing-customer cohort, even with GATE_PREPAY_CARD_AND_CHARGE on', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
    const gates = require('../config/feature-gates').gates;
    gates.autoApplyAccountCredit = true;
    try {
      // control: a NEW customer on the rail does get in-lane prepay
      expect((await policyFor(CAPTURE)).prepayInLane).toBe(true);
      for (const policy of [
        { enforced: true, required: true, exemptReason: null, afterVisitCard: true },
        { enforced: true, required: true, exemptReason: null, afterVisitCard: true, autopayPaused: true },
        { enforced: true, required: true, exemptReason: null, afterVisitCard: true, autopayDisabled: true },
        { enforced: true, required: false, exemptReason: 'saved_method_consented', afterVisitCard: true },
      ]) {
        expect((await policyFor(policy)).prepayInLane).toBe(false);
      }
    } finally {
      delete gates.autoApplyAccountCredit;
      delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
    }
  });

  // PR-E (GATE_PAF_PREPAY): the after-visit prepay flag follows the accept's
  // own predicate, which never applies to a termite annual sign-before-pay
  // plan (that accept parks for signature; GitHub Codex #5595 r1).
  test('PR-E: prepayAfterFirstVisit for an in-lane prepay, never a termite sign-before-pay plan', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
    process.env.GATE_PAF_PREPAY = 'true';
    const gates = require('../config/feature-gates').gates;
    gates.autoApplyAccountCredit = true;
    try {
      expect((await policyFor(CAPTURE)).prepayAfterFirstVisit).toBe(true);
      const parked = await policyFor(CAPTURE, { annual_plan_activation_status: 'awaiting_signature' });
      expect(parked).not.toHaveProperty('prepayAfterFirstVisit');
      delete process.env.GATE_PAF_PREPAY;
      expect(await policyFor(CAPTURE)).not.toHaveProperty('prepayAfterFirstVisit');
    } finally {
      delete gates.autoApplyAccountCredit;
      delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
      delete process.env.GATE_PAF_PREPAY;
    }
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
      expect(p).not.toHaveProperty('afterVisitPaused');
      expect(p).not.toHaveProperty('afterVisitAutopayOff');
    }
  });

  test('PR-B: gate off (resolver returns today\'s policy) leaves the payload byte-identical', async () => {
    const p = await policyFor({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
    expect(Object.keys(p).sort()).toEqual(['enforced', 'exemptReason', 'prepayInLane', 'required']);
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

  // Codex round 2 P0: the promise is ONE shared server predicate (/data, the
  // legacy page copy and the accept's attestation check all call it). A legacy
  // estimate whose linked customer is a CURRENT monthly member keeps monthly
  // billing at accept (the converter preserves the lane), so the accept would
  // mint a payable setup invoice — the page must not promise first-visit billing.
  describe('estimateSetupFeePromiseLaneOk (the lane half of the promise)', () => {
    const { estimateSetupFeePromiseLaneOk } = estimatePublicRouter;
    beforeEach(() => { dbRows = {}; });

    test('a brand-new contact (no linked customer, no phone) converts per-application: promised', async () => {
      expect(await estimateSetupFeePromiseLaneOk({ id: 'e1' })).toBe(true);
    });
    test('a linked CURRENT monthly member (legacy estimate, no membership snapshot): NOT promised', async () => {
      dbRows = { customers: { id: 'c1', pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: 'monthly_membership', waveguard_tier: 'Bronze' } };
      expect(await estimateSetupFeePromiseLaneOk({ id: 'e1', customer_id: 'c1' })).toBe(false);
      dbRows = { customers: { id: 'c1', pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: null } };
      expect(await estimateSetupFeePromiseLaneOk({ id: 'e1', customer_id: 'c1' })).toBe(false);
    });
    test('a linked per-application / non-member customer: promised', async () => {
      dbRows = { customers: { id: 'c1', pipeline_stage: 'active_customer', monthly_rate: 0, billing_mode: 'per_application' } };
      expect(await estimateSetupFeePromiseLaneOk({ id: 'e1', customer_id: 'c1' })).toBe(true);
      dbRows = { customers: { id: 'c1', pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: 'per_application' } };
      expect(await estimateSetupFeePromiseLaneOk({ id: 'e1', customer_id: 'c1' })).toBe(true);
    });
    test('a lookup failure fails CLOSED: not promised', async () => {
      db.mockImplementationOnce(() => { throw new Error('customers lookup down'); });
      expect(await estimateSetupFeePromiseLaneOk({ id: 'e1', customer_id: 'c1' })).toBe(false);
    });
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
