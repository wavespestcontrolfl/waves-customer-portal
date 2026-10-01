// Recurring card-on-file (Auto Pay at accept). Mirrors the estimate-card-holds
// test harness: db + stripe + logger mocked, the policy decision logic
// exercised directly, the trust-boundary verify path checked against Stripe,
// and the post-commit save → consent → enroll sequence pinned so it can't
// drift from the pay page's /setup-complete semantics.

let mockDbFixtures = {};
jest.mock('../models/db', () => {
  // Self-returning chain so the grouped-sibling lookup's longer chain
  // (where → whereNot → whereNotNull → orderBy → first) resolves from the
  // same per-table fixture as the simple where().first() reads.
  const chain = (table) => {
    const c = {
      first: async (...args) => {
        const v = mockDbFixtures[table];
        if (typeof v === 'function') return v(...args);
        return v ?? null;
      },
    };
    for (const m of ['where', 'whereNot', 'whereNotNull', 'whereNull', 'whereIn', 'orderBy', 'forUpdate']) c[m] = () => c;
    return c;
  };
  const mock = jest.fn((table) => chain(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  // Replacement runs under the estimate row lock: the trx handle reads the
  // same per-table fixtures (mockDbFixtures.estimates = the locked row).
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => chain(table));
    trx.fn = mock.fn;
    mock.__lastTrx = trx;
    return fn(trx);
  });
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockRetrieveSetupIntent = jest.fn();
const mockCreateRecurringCardSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
const mockRetrievePaymentMethod = jest.fn();
const mockRetireSetupIntent = jest.fn();
const mockMarkAfterVisit = jest.fn();
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  createRecurringCardSetupIntent: (...a) => mockCreateRecurringCardSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
  retrievePaymentMethod: (...a) => mockRetrievePaymentMethod(...a),
  retireSetupIntent: (...a) => mockRetireSetupIntent(...a),
  markSetupIntentAfterVisit: (...a) => mockMarkAfterVisit(...a),
}));

const mockQualifyingRows = jest.fn(async () => []);
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: (...a) => mockQualifyingRows(...a),
}));
// Label provenance defaults to a verified non-label (legacy scenarios);
// override to 'label' / 'unknown' to assert the card gate stays required.
const mockTierLabelStatus = jest.fn(async () => 'not_label');
jest.mock('../services/self-booking-plan-sync', () => ({
  tierLabelStatus: (...args) => mockTierLabelStatus(...args),
}));
const mockResolveForInvoice = jest.fn(async () => null);
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...a) => mockResolveForInvoice(...a),
}));
const mockCustomerOnAutopay = jest.fn(async () => false);
const mockIsPaused = jest.fn(() => false);
const mockGetChargeableAutopayMethod = jest.fn(async () => null);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockCustomerOnAutopay(...a),
  isPaused: (...a) => mockIsPaused(...a),
  getChargeableAutopayMethod: (...a) => mockGetChargeableAutopayMethod(...a),
}));
const mockHasConsentFor = jest.fn(async () => false);
// Enrollment-scoped twin (r6 P1): the enrollment path now consults THIS —
// a hold-only consent must not suppress the estimate_accept record.
const mockHasEnrollmentScopedConsent = jest.fn(async () => false);
const mockRecordConsent = jest.fn(async () => ({ id: 'consent1' }));
const mockLinkPaymentMethodId = jest.fn(async () => {});
const mockFindConsentedChargeableCard = jest.fn(async () => null);
const mockHasConsentSnapshotForVariant = jest.fn(async () => false);
jest.mock('../services/payment-method-consents', () => ({
  hasConsentFor: (...a) => mockHasConsentFor(...a),
  hasEnrollmentScopedConsent: (...a) => mockHasEnrollmentScopedConsent(...a),
  hasConsentSnapshotForVariant: (...a) => mockHasConsentSnapshotForVariant(...a),
  recordConsent: (...a) => mockRecordConsent(...a),
  linkPaymentMethodId: (...a) => mockLinkPaymentMethodId(...a),
  findConsentedChargeableCard: (...a) => mockFindConsentedChargeableCard(...a),
}));
const mockEnrollConsentedMethod = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/autopay-enrollment', () => ({
  enrollConsentedMethod: (...a) => mockEnrollConsentedMethod(...a),
}));
const mockNotifyAdmin = jest.fn(async () => {});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
// The policy's linked-appointment fallback lazy-requires the route module —
// stub it so tests never load the real (heavy) estimate-public.
const mockMatchAcceptCustomerByPhone = jest.fn(async () => ({ match: null }));
jest.mock('../routes/estimate-public', () => ({
  findLinkedUpcomingAppointment: jest.fn(async () => null),
  matchAcceptCustomerByPhone: (...a) => mockMatchAcceptCustomerByPhone(...a),
  // Status/expiry slice of the real accept-active gate (the replacement
  // re-judges it under the row lock).
  isEstimateAcceptActive: (e = {}) => !e.archived_at
    && !['accepted', 'declined', 'expired', 'send_failed', 'draft', 'scheduled'].includes(e.status)
    && !(e.expires_at && new Date(e.expires_at) < new Date()),
}));

const {
  isRecurringCardOnFileEnabled,
  isPrepayCardAndChargeEnabled,
  resolveRecurringCardPolicyForEstimate,
  resolvePrepayChargeMethod,
  prepayChargeMethodKey,
  sweepStrandedPrepayAutoCharges,
  createRecurringCardSetupIntentForEstimate,
  verifyRecurringCardIntent,
  verifyRecurringCardIntentUnderLock,
  replaceRecurringCardIntent,
  bankTenderAllowedUnderLock,
  completeRecurringCardEnrollment,
  afterVisitHeld,
  explicitAutopayDisable,
  pafExistingDriftUnderLock,
  applyCommercialManualBillingExemption,
  payAfterFirstVisitCardRail,
  payAfterFirstVisitInvoiceRail,
  _private: { recurringCardIntentMatchesEstimate, classifyDeliveryOutcome },
} = require('../services/recurring-card-on-file');

const EST = { id: 'est-1', customer_id: 'cust-1' };
const GOOD_SI = {
  id: 'seti_1',
  status: 'succeeded',
  payment_method: 'pm_1',
  metadata: { purpose: 'estimate_recurring_card', estimate_id: 'est-1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDbFixtures = {};
  process.env.RECURRING_CARD_ON_FILE = 'true';
  mockQualifyingRows.mockResolvedValue([]);
  mockResolveForInvoice.mockResolvedValue(null);
  mockCustomerOnAutopay.mockResolvedValue(false);
  mockHasConsentFor.mockResolvedValue(false);
  mockHasEnrollmentScopedConsent.mockResolvedValue(false);
  mockFindConsentedChargeableCard.mockResolvedValue(null);
  mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: null });
});
afterAll(() => {
  delete process.env.RECURRING_CARD_ON_FILE;
  delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
  delete process.env.GATE_PAF_EXISTING_CUSTOMERS;
});

describe('feature flag', () => {
  it('is off unless RECURRING_CARD_ON_FILE is truthy', () => {
    delete process.env.RECURRING_CARD_ON_FILE;
    expect(isRecurringCardOnFileEnabled()).toBe(false);
    for (const v of ['true', '1', 'on']) {
      process.env.RECURRING_CARD_ON_FILE = v;
      expect(isRecurringCardOnFileEnabled()).toBe(true);
    }
    process.env.RECURRING_CARD_ON_FILE = 'false';
    expect(isRecurringCardOnFileEnabled()).toBe(false);
  });
});

// GATE_PAY_AFTER_FIRST_VISIT (owner ruling 2026-09-30): the pay-after-first-
// visit wording is for customers on the card rail only. Every exempt customer
// keeps today's wording because their accept follows today's billing path.
describe('GATE_PAY_AFTER_FIRST_VISIT (payAfterFirstVisitCardRail)', () => {
  const featureGates = require('../config/feature-gates');
  afterEach(() => { delete process.env.GATE_PAY_AFTER_FIRST_VISIT; });

  it('is dark unless the env is exactly "true"', () => {
    delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
    expect(featureGates.payAfterFirstVisitLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'false', '']) {
      process.env.GATE_PAY_AFTER_FIRST_VISIT = v;
      expect(featureGates.payAfterFirstVisitLive()).toBe(false);
    }
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    expect(featureGates.payAfterFirstVisitLive()).toBe(true);
  });

  it('gate off: nobody is on the card-rail wording, whatever the policy', () => {
    for (const policy of [
      { enforced: true, required: true, exemptReason: null },
      { enforced: true, required: false, exemptReason: 'saved_method_consented' },
      { enforced: true, required: false, exemptReason: 'autopay_already_active' },
    ]) {
      expect(payAfterFirstVisitCardRail(policy)).toBe(false);
    }
  });

  it('gate on: a required capture and the already-enrolled customers are on the rail', () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    expect(payAfterFirstVisitCardRail({ enforced: true, required: true, exemptReason: null })).toBe(true);
    expect(payAfterFirstVisitCardRail({ enforced: true, required: false, exemptReason: 'saved_method_consented' })).toBe(true);
    expect(payAfterFirstVisitCardRail({ enforced: true, required: false, exemptReason: 'autopay_already_active' })).toBe(true);
  });

  it('gate on: every exemption keeps today\'s wording', () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    for (const exemptReason of [
      'one_time_card_hold_lane', 'invoice_mode', 'prepay_annual', 'commercial_manual_billing',
      'payer_billed', 'payer_check_uncertain', 'autopay_paused', 'existing_plan_customer',
    ]) {
      expect(payAfterFirstVisitCardRail({ enforced: true, required: false, exemptReason })).toBe(false);
    }
    expect(payAfterFirstVisitCardRail(null)).toBe(false);
  });

  it('gate on but the recurring card lane is off: no card is ever saved, so no card-rail wording', () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    delete process.env.RECURRING_CARD_ON_FILE;
    expect(payAfterFirstVisitCardRail({ enforced: false, required: false, exemptReason: 'feature_disabled' })).toBe(false);
    expect(payAfterFirstVisitCardRail({ enforced: true, required: true, exemptReason: null })).toBe(false);
  });

  it('end to end through the resolver: new customer on the rail; existing plan customer and payer-billed are not', async () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    const fresh = await resolveRecurringCardPolicyForEstimate({ estimate: { id: 'est-9', customer_id: null } });
    expect(payAfterFirstVisitCardRail(fresh)).toBe(true);
    const member = await resolveRecurringCardPolicyForEstimate({
      estimate: EST, membership: { isExistingCustomer: true },
    });
    expect(member.exemptReason).toBe('existing_plan_customer');
    expect(payAfterFirstVisitCardRail(member)).toBe(false);
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    const payer = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(payer.exemptReason).toBe('payer_billed');
    expect(payAfterFirstVisitCardRail(payer)).toBe(false);
  });
});

// payAfterFirstVisitInvoiceRail: the ONE "this accept's invoice rides the card
// lane" predicate shared by estimate-public.js's three consumers. PR-A: it is
// exactly the inline predicate they used before (no gate, no flag, no
// `enforced` read), so it must not move with GATE_PAY_AFTER_FIRST_VISIT.
describe('payAfterFirstVisitInvoiceRail (shared lane predicate)', () => {
  afterEach(() => { delete process.env.GATE_PAY_AFTER_FIRST_VISIT; });

  const CASES = [
    [{ required: true, exemptReason: null }, true],
    [{ required: false, exemptReason: 'saved_method_consented' }, true],
    [{ required: false, exemptReason: 'autopay_already_active' }, true],
    [{ required: false, exemptReason: 'existing_plan_customer' }, false],
    [{ required: false, exemptReason: 'autopay_paused' }, false],
    [{ required: false, exemptReason: 'payer_billed' }, false],
    [{ required: false, exemptReason: 'payer_check_uncertain' }, false],
    [{ required: false, exemptReason: 'commercial_manual_billing' }, false],
    [{ required: false, exemptReason: 'prepay_annual' }, false],
    [{ required: false, exemptReason: 'feature_disabled' }, false],
    [{ required: false, exemptReason: null }, false],
    [null, false],
    [undefined, false],
  ];

  it('matches the pre-existing inline predicate for every policy shape', () => {
    const inline = (policy) => policy.required
      || ['saved_method_consented', 'autopay_already_active'].includes(policy.exemptReason || '');
    for (const [policy, expected] of CASES) {
      expect(payAfterFirstVisitInvoiceRail(policy)).toBe(expected);
      if (policy) expect(!!inline(policy)).toBe(expected);
    }
  });

  it('does not move with the master gate (gate on or off, same answer)', () => {
    for (const gate of [undefined, 'true']) {
      if (gate) process.env.GATE_PAY_AFTER_FIRST_VISIT = gate; else delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
      for (const [policy, expected] of CASES) {
        expect(payAfterFirstVisitInvoiceRail(policy)).toBe(expected);
      }
    }
  });

  it('payAfterFirstVisitCardRail is this predicate plus the gate, the card lane, and an enforced policy', () => {
    process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
    for (const [policy, expected] of CASES) {
      const enforced = policy ? { ...policy, enforced: true } : policy;
      expect(payAfterFirstVisitCardRail(enforced)).toBe(expected);
    }
    expect(payAfterFirstVisitCardRail({ required: true, exemptReason: null, enforced: false })).toBe(false);
  });
});

describe('resolveRecurringCardPolicyForEstimate', () => {
  it('is inert while the flag is off', async () => {
    delete process.env.RECURRING_CARD_ON_FILE;
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p).toEqual({ enforced: false, required: false, exemptReason: 'feature_disabled' });
  });

  it('exempts the one-time lane (card hold owns it)', async () => {
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, treatAsOneTime: true });
    expect(p.required).toBe(false);
    expect(p.exemptReason).toBe('one_time_card_hold_lane');
  });

  it('exempts invoice-mode and prepay-annual', async () => {
    expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, billByInvoice: true })).exemptReason).toBe('invoice_mode');
    expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, paymentMethodPreference: 'prepay_annual' })).exemptReason).toBe('prepay_annual');
  });

  // Owner ruling 2026-08-25 (supersedes the 2026-07-12 prepay carve-out):
  // with GATE_PREPAY_CARD_AND_CHARGE on, a prepay accept requires the card
  // exactly like per-application — the legacy exemption fired on the false
  // premise that the year was paid at accept, and two prepay accepts were
  // serviced unpaid.
  describe('GATE_PREPAY_CARD_AND_CHARGE (prepay joins the card lane)', () => {
    afterEach(() => { delete process.env.GATE_PREPAY_CARD_AND_CHARGE; });

    it('is off unless GATE_PREPAY_CARD_AND_CHARGE is truthy', () => {
      delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
      expect(isPrepayCardAndChargeEnabled()).toBe(false);
      for (const v of ['true', '1', 'on']) {
        process.env.GATE_PREPAY_CARD_AND_CHARGE = v;
        expect(isPrepayCardAndChargeEnabled()).toBe(true);
      }
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'false';
      expect(isPrepayCardAndChargeEnabled()).toBe(false);
    });

    it('is a CONJUNCTION with the master gate — prepay gate alone stays off', () => {
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
      delete process.env.RECURRING_CARD_ON_FILE;
      expect(isPrepayCardAndChargeEnabled()).toBe(false);
      process.env.RECURRING_CARD_ON_FILE = 'true';
      expect(isPrepayCardAndChargeEnabled()).toBe(true);
    });

    it('keeps the legacy prepay exemption while the gate is off (kill switch restores today)', async () => {
      delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, paymentMethodPreference: 'prepay_annual' });
      expect(p).toEqual({ enforced: true, required: false, exemptReason: 'prepay_annual' });
    });

    it('requires the card for a NEW customer prepay accept when the gate is on', async () => {
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, paymentMethodPreference: 'prepay_annual' });
      expect(p.enforced).toBe(true);
      expect(p.required).toBe(true);
      expect(p.exemptReason).toBe(null);
    });

    it('in-lane prepay still honors the payer-billed exemption (never enroll the homeowner for payer bills)', async () => {
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
      mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, paymentMethodPreference: 'prepay_annual', scheduledServiceId: 'ss-9', useLinkedFallback: false });
      expect(p.required).toBe(false);
      expect(p.exemptReason).toBe('payer_billed');
    });

    it('in-lane prepay auto-satisfies with a saved consented card (never re-ask a member)', async () => {
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
      mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pmrow-1' });
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, paymentMethodPreference: 'prepay_annual' });
      expect(p.required).toBe(false);
      expect(p.exemptReason).toBe('saved_method_consented');
      expect(p.savedMethodRowId).toBe('pmrow-1');
    });

    it('in-lane prepay stays REQUIRED behind the master flag being on (RECURRING_CARD_ON_FILE off wins)', async () => {
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
      delete process.env.RECURRING_CARD_ON_FILE;
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, paymentMethodPreference: 'prepay_annual' });
      expect(p).toEqual({ enforced: false, required: false, exemptReason: 'feature_disabled' });
    });
  });

  describe('resolvePrepayChargeMethod (quote-time method + funding)', () => {
    it('resolves the live-verified SetupIntent capture with Stripe funding (no row yet)', async () => {
      mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_1', type: 'card', card: { funding: 'credit', last4: '4242' } });
      const m = await resolvePrepayChargeMethod({ verification: { ok: true, paymentMethodId: 'pm_1' }, customerId: 'cust-1' });
      expect(m).toEqual({ stripePaymentMethodId: 'pm_1', paymentMethodRowId: null, methodType: 'card', funding: 'credit', last4: '4242', source: 'fresh_capture' });
    });

    it('resolves a fresh BANK capture (GATE_ACCEPT_ACH_CAPTURE) with no funding guard and the bank last4', async () => {
      mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_b', type: 'us_bank_account', us_bank_account: { last4: '6789', bank_name: 'Test Bank' } });
      const m = await resolvePrepayChargeMethod({ verification: { ok: true, paymentMethodId: 'pm_b' }, customerId: 'cust-1' });
      expect(m).toEqual({ stripePaymentMethodId: 'pm_b', paymentMethodRowId: null, methodType: 'us_bank_account', funding: null, last4: '6789', source: 'fresh_capture' });
    });

    it('resolves the auto-satisfy saved method row', async () => {
      mockDbFixtures.payment_methods = { id: 'pmrow-1', customer_id: 'cust-1', stripe_payment_method_id: 'pm_9', method_type: 'card', card_funding: 'debit', last_four: '1111' };
      const m = await resolvePrepayChargeMethod({ policy: { savedMethodRowId: 'pmrow-1' }, customerId: 'cust-1' });
      expect(m.paymentMethodRowId).toBe('pmrow-1');
      expect(m.funding).toBe('debit');
    });

    it('falls back to the ACTIVE Auto Pay method for autopay_already_active (pre-push P0: these accepts previously skipped the charge)', async () => {
      mockDbFixtures.customers = { autopay_payment_method_id: 'pmrow-7' };
      mockDbFixtures.payment_methods = { id: 'pmrow-7', customer_id: 'cust-1', stripe_payment_method_id: 'pm_7', method_type: 'card', card_funding: 'credit', last_four: '7777' };
      mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true, autopay_payment_method_id: null };
      // Codex r15: the CANONICAL resolver picks the method — a null/stale
      // customers.autopay_payment_method_id pointer must not matter.
      mockGetChargeableAutopayMethod.mockResolvedValue({ id: 'pmrow-7' });
      const m = await resolvePrepayChargeMethod({ policy: { exemptReason: 'autopay_already_active' }, customerId: 'cust-1' });
      // The resolver REQUIRES its knex handle (Codex r23: omitting it threw
      // inside the helper, was caught, and 503'd every autopay quote).
      expect(mockGetChargeableAutopayMethod).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }), expect.anything());
      expect(m.paymentMethodRowId).toBe('pmrow-7');
      expect(m.stripePaymentMethodId).toBe('pm_7');
    });

    it('returns null when nothing resolves (no quote → no charge; pay-link fallback owns it)', async () => {
      expect(await resolvePrepayChargeMethod({ policy: {}, customerId: 'cust-1' })).toBe(null);
    });

    it('never resolves a row owned by another customer', async () => {
      mockDbFixtures.payment_methods = { id: 'pmrow-1', customer_id: 'cust-OTHER', stripe_payment_method_id: 'pm_9', method_type: 'card', card_funding: 'debit' };
      expect(await resolvePrepayChargeMethod({ policy: { savedMethodRowId: 'pmrow-1' }, customerId: 'cust-1' })).toBe(null);
    });

    it('never throws — a Stripe failure resolves null', async () => {
      mockRetrievePaymentMethod.mockRejectedValue(new Error('stripe down'));
      expect(await resolvePrepayChargeMethod({ verification: { ok: true, paymentMethodId: 'pm_1' }, customerId: 'cust-1' })).toBe(null);
    });
  });

  describe('prepayChargeMethodKey (quote↔ack method binding)', () => {
    it('is deterministic, truncated, and never the raw Stripe id', () => {
      const key = prepayChargeMethodKey('pm_abc123');
      expect(key).toHaveLength(16);
      expect(key).toBe(prepayChargeMethodKey('pm_abc123'));
      expect(key).not.toContain('pm_');
      expect(prepayChargeMethodKey('pm_other')).not.toBe(key);
      expect(prepayChargeMethodKey(null)).toBe(null);
    });
  });

  describe('classifyDeliveryOutcome — the sweep\'s payer-billed and card-decline fallback deliveries share this (Codex round-8 audit P1 #4131)', () => {
    test('settled_zero_due: settled, never reported delivered, and NOT reported credit-covered (Codex round-8 audit P2 #4131 slice 4)', () => {
      // settleZeroBalance also closes an invoice retotaled/discounted to a
      // literal $0 with credit_applied = 0 — the generic settled_zero_due
      // code proves nothing about deposit/account credit, so a caller
      // building alert copy off this classification must not invent a
      // credit transaction that never happened.
      expect(classifyDeliveryOutcome({ ok: true, settled_zero_due: true }))
        .toEqual({ settled: true, delivered: false, creditCovered: false });
    });

    test('covered_by_credit: settled, never reported delivered, and IS reported credit-covered', () => {
      expect(classifyDeliveryOutcome({ ok: true, covered_by_credit: true }))
        .toEqual({ settled: true, delivered: false, creditCovered: true });
    });

    test('an ordinary successful send: delivered, not settled, not credit-covered', () => {
      expect(classifyDeliveryOutcome({ ok: true, sms: { ok: true }, email: { ok: true } }))
        .toEqual({ settled: false, delivered: true, creditCovered: false });
    });

    test('a genuine failure (ok: false): neither settled nor delivered nor credit-covered', () => {
      expect(classifyDeliveryOutcome({ ok: false, code: 'payer_billed' }))
        .toEqual({ settled: false, delivered: false, creditCovered: false });
    });

    test('a null/undefined result (an unresolved fence, or the catch path): neither settled nor delivered nor credit-covered', () => {
      expect(classifyDeliveryOutcome(null)).toEqual({ settled: false, delivered: false, creditCovered: false });
      expect(classifyDeliveryOutcome(undefined)).toEqual({ settled: false, delivered: false, creditCovered: false });
    });
  });

  describe('prepay recovery fallback pay link vs a collections dispute hold (owner ruling 2026-09-30)', () => {
    // The sweep is too large to drive here; pin the ordering that matters: the live
    // hold check (fail closed, job left claimed for the lease) sits before the
    // direct sender that delivers the fallback pay link.
    it('checks the live hold before the fallback delivery and leaves the job retryable', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../services/recurring-card-on-file.js'), 'utf8');
      const guard = src.indexOf('const fallbackHold = await require(\'./collections/collection-hold\')');
      const send = src.indexOf("withJobFence(async () => require('./invoice').sendViaSMSAndEmail(job.invoice_id))", guard);
      expect(guard).toBeGreaterThan(0);
      expect(send).toBeGreaterThan(guard);
      const block = src.slice(guard, send);
      expect(block).toMatch(/messagingHeldByCollectionHold\(/);
      expect(block).toMatch(/if \(fallbackHold\.held\) \{[\s\S]*continue;/);
      expect(block).not.toMatch(/resolve\(/);
    });
  });

  describe('sweepStrandedPrepayAutoCharges', () => {
    it('still scans with the gate OFF (kill switch must drain committed jobs, not strand them)', async () => {
      delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
      // The minimal db mock has no whereRaw chain — the scan attempt throws
      // and degrades to scanned:0; the load-bearing assertion is that the
      // gate no longer short-circuits before the scan (Codex r6 P0).
      expect(await sweepStrandedPrepayAutoCharges()).toEqual({ scanned: 0 });
      expect(require('../models/db')).toHaveBeenCalledWith('estimates');
    });

    it('degrades to scanned:0 when the scan query fails (never throws into the cron)', async () => {
      process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
      try {
        // The minimal db mock has no whereRaw chain — the scan throws and
        // the sweep must swallow it.
        expect(await sweepStrandedPrepayAutoCharges()).toEqual({ scanned: 0 });
      } finally {
        delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
      }
    });
  });

  it('exempts an existing plan customer via the membership snapshot', async () => {
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: { isExistingCustomer: true } });
    expect(p.required).toBe(false);
    expect(p.exemptReason).toBe('existing_plan_customer');
    expect(mockQualifyingRows).not.toHaveBeenCalled();
  });

  it('exempts an existing plan customer via the LIVE fallback', async () => {
    mockQualifyingRows.mockResolvedValue([{ id: 'svc' }]);
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.exemptReason).toBe('existing_plan_customer');
  });

  // Prod incident 2026-09-18: a lawn member on per-application Auto Pay
  // accepted a pest estimate and got a due-today pay-link invoice texted +
  // emailed, because the plan-member exemption returned before the Auto Pay
  // check and only `autopay_already_active` / `saved_method_consented` count
  // as the hold-for-completion lane in the accept route.
  describe('existing plan member on Auto Pay classifies into the completion-charge lane', () => {
    it('reports autopay_already_active for a member (snapshot) already on Auto Pay', async () => {
      mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true };
      mockCustomerOnAutopay.mockResolvedValue(true);
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: { isExistingCustomer: true } });
      expect(p.required).toBe(false);
      expect(p.exemptReason).toBe('autopay_already_active');
    });

    it('reports autopay_already_active for a member (LIVE rows) already on Auto Pay', async () => {
      mockQualifyingRows.mockResolvedValue([{ id: 'svc' }]);
      mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true };
      mockCustomerOnAutopay.mockResolvedValue(true);
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
      expect(p.exemptReason).toBe('autopay_already_active');
    });

    it('keeps a payer-billed member OUT of the lane (completion never auto-charges payer invoices)', async () => {
      mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
      mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true };
      mockCustomerOnAutopay.mockResolvedValue(true);
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: { isExistingCustomer: true }, scheduledServiceId: 'ss-9', useLinkedFallback: false });
      expect(p.required).toBe(false);
      expect(p.exemptReason).toBe('payer_billed');
    });

    it('keeps an autopay-PAUSED member on the payable path', async () => {
      mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true, autopay_paused_until: '2099-01-01' };
      mockIsPaused.mockReturnValue(true);
      try {
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: { isExistingCustomer: true } });
        expect(p.exemptReason).toBe('autopay_paused');
      } finally {
        mockIsPaused.mockReturnValue(false);
      }
    });

    it('still reports existing_plan_customer for a member NOT on Auto Pay, even with a consented saved card (no enrollment by a later accept)', async () => {
      mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pmrow-7', stripe_payment_method_id: 'pm_7' });
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: { isExistingCustomer: true } });
      expect(p.required).toBe(false);
      expect(p.exemptReason).toBe('existing_plan_customer');
      expect(p.savedMethodRowId).toBeUndefined();
      expect(mockFindConsentedChargeableCard).not.toHaveBeenCalled();
    });
  });

  // PR-B (GATE_PAF_EXISTING_CUSTOMERS, owner ruling 2026-09-30/10-01): existing
  // customers adding a service save/use a card and pay AFTER the visit. Live
  // only when BOTH GATE_PAY_AFTER_FIRST_VISIT and GATE_PAF_EXISTING_CUSTOMERS
  // are exactly 'true'; every other state is today's behavior.
  describe('GATE_PAF_EXISTING_CUSTOMERS (existing customers join the pay-after-first-visit card rail)', () => {
    const MEMBER = { isExistingCustomer: true };
    const PER_APP_CUSTOMER = {
      id: 'cust-1', pipeline_stage: 'active_customer', billing_mode: 'per_application', monthly_rate: 40, autopay_enabled: true,
    };
    const MONTHLY_CUSTOMER = {
      id: 'cust-1', pipeline_stage: 'active_customer', billing_mode: 'monthly_membership', monthly_rate: 80, autopay_enabled: false,
    };
    const live = () => { process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true'; process.env.GATE_PAF_EXISTING_CUSTOMERS = 'true'; };
    afterEach(() => {
      delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
      delete process.env.GATE_PAF_EXISTING_CUSTOMERS;
      mockIsPaused.mockReturnValue(false);
    });

    it('gate off (sub-gate unset, or master unset): a plan member and a paused customer stay exempt exactly as today', async () => {
      mockDbFixtures.customers = PER_APP_CUSTOMER;
      // sub-gate alone, master off
      process.env.GATE_PAF_EXISTING_CUSTOMERS = 'true';
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
      // master alone, sub-gate off
      delete process.env.GATE_PAF_EXISTING_CUSTOMERS;
      process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
      mockIsPaused.mockReturnValue(true);
      const paused = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(paused.exemptReason).toBe('autopay_paused');
      expect(paused).not.toHaveProperty('afterVisitCard');
    });

    it('gate on: an existing plan member with no saved card is REQUIRED to capture one (card-required lane, after_visit_card marker)', async () => {
      live();
      mockCustomerOnAutopay.mockResolvedValue(false);
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_enabled: false };
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(p).toEqual({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, customerId: 'cust-1' });
      // The shared lane predicate (accept suppression, /data, renderer pick)
      // and the copy rail both see this customer as on the rail.
      expect(payAfterFirstVisitInvoiceRail(p)).toBe(true);
      expect(payAfterFirstVisitCardRail(p)).toBe(true);
    });

    it('gate on: a member with a consented saved card auto-satisfies (no re-ask) and carries the marker + row id', async () => {
      live();
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_enabled: false };
      mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pmrow-7', stripe_payment_method_id: 'pm_7' });
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(p).toEqual({ enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pmrow-7', afterVisitCard: true, customerId: 'cust-1' });
      expect(payAfterFirstVisitInvoiceRail(p)).toBe(true);
    });

    it('gate on: a LIVE-rows plan member (no membership snapshot) moves too', async () => {
      live();
      mockQualifyingRows.mockResolvedValue([{ id: 'svc' }]);
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_enabled: false };
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
      expect(p.required).toBe(true);
      expect(p.afterVisitCard).toBe(true);
    });

    it('gate on: a member ALREADY on Auto Pay is unchanged (autopay_already_active, no marker)', async () => {
      live();
      mockDbFixtures.customers = PER_APP_CUSTOMER;
      mockCustomerOnAutopay.mockResolvedValue(true);
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(p).toEqual({ enforced: true, required: false, exemptReason: 'autopay_already_active' });
    });

    it('gate on, owner R5 (paused Auto Pay): the card is captured/kept, NOT exempt, never un-paused, and Auto Pay eligibility is never consulted', async () => {
      live();
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_paused_until: '2099-01-01' };
      mockIsPaused.mockReturnValue(true);
      const noCard = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(noCard).toEqual({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, customerId: 'cust-1', autopayPaused: true });
      expect(payAfterFirstVisitInvoiceRail(noCard)).toBe(true);
      // A consented saved card is kept (auto-satisfy), still marked paused.
      mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pmrow-7', stripe_payment_method_id: 'pm_7' });
      const withCard = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(withCard).toEqual({
        enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pmrow-7', customerId: 'cust-1', afterVisitCard: true, autopayPaused: true,
      });
      // The pause is never lifted by the policy: no autopay write happens in
      // the resolver, and customerOnAutopay (which would be false anyway
      // while paused) is skipped.
      expect(mockCustomerOnAutopay).not.toHaveBeenCalled();
      expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
    });

    it('gate on: a paused NON-member (no plan rows) moves to the rail as well', async () => {
      live();
      mockDbFixtures.customers = { id: 'cust-1', pipeline_stage: 'lead', billing_mode: null, monthly_rate: null, autopay_paused_until: '2099-01-01' };
      mockIsPaused.mockReturnValue(true);
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
      expect(p.required).toBe(true);
      expect(p.autopayPaused).toBe(true);
    });

    it('gate on: the monthly-membership lane is UNCHANGED (add-on joins monthly_rate; R4 not built) — member and paused member stay exempt', async () => {
      live();
      mockDbFixtures.customers = MONTHLY_CUSTOMER;
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
      // NULL billing_mode with a real rate is the same legacy monthly lane.
      mockDbFixtures.customers = { ...MONTHLY_CUSTOMER, billing_mode: null };
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
      mockDbFixtures.customers = { ...MONTHLY_CUSTOMER, autopay_paused_until: '2099-01-01' };
      mockIsPaused.mockReturnValue(true);
      const paused = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(paused.exemptReason).toBe('autopay_paused');
      expect(paused).not.toHaveProperty('afterVisitCard');
    });

    it('gate on: an annual-prepay-lane member stays exempt (term coverage, not per-application billing)', async () => {
      live();
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, billing_mode: 'annual_prepay', autopay_enabled: false };
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
    });

    it('gate on: no resolvable customer row keeps today\'s exemption (a lookup gap never moves anyone)', async () => {
      live();
      mockDbFixtures.customers = null;
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
    });

    it('gate on: payer-billed, payer_check_uncertain, invoice_mode, one-time and legacy-prepay stay exactly as today', async () => {
      live();
      mockDbFixtures.customers = PER_APP_CUSTOMER;
      mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('payer_billed');
      mockResolveForInvoice.mockRejectedValue(new Error('payer svc down'));
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('payer_check_uncertain');
      mockResolveForInvoice.mockResolvedValue(null);
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER, billByInvoice: true })).exemptReason).toBe('invoice_mode');
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER, treatAsOneTime: true })).exemptReason).toBe('one_time_card_hold_lane');
      expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER, paymentMethodPreference: 'prepay_annual' })).exemptReason).toBe('prepay_annual');
    });

    it('gate on: a payer-billed PAUSED customer is still payer_billed (payer check runs before the pause)', async () => {
      live();
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_paused_until: '2099-01-01' };
      mockIsPaused.mockReturnValue(true);
      mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(p.exemptReason).toBe('payer_billed');
      expect(p).not.toHaveProperty('afterVisitCard');
    });

    // GitHub Codex #5481 r1 P1/P2: with GATE_PREPAY_CARD_AND_CHARGE on, a
    // prepay_annual preference reaches the customer-dependent exemptions; the
    // PR-B widening must not move an existing member into the in-lane prepay
    // charge-at-accept plan (refused for paused customers by stripe.js).
    describe('annual prepay with GATE_PREPAY_CARD_AND_CHARGE on is NOT widened', () => {
      afterEach(() => { delete process.env.GATE_PREPAY_CARD_AND_CHARGE; });

      it('paused member + prepay_annual: today\'s autopay_paused exemption, no marker', async () => {
        live();
        process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
        mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_paused_until: '2099-01-01' };
        mockIsPaused.mockReturnValue(true);
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER, paymentMethodPreference: 'prepay_annual' });
        expect(p).toEqual({ enforced: true, required: false, exemptReason: 'autopay_paused' });
        expect(payAfterFirstVisitInvoiceRail(p)).toBe(false);
      });

      it('non-autopay member + prepay_annual: today\'s existing_plan_customer exemption, no marker', async () => {
        live();
        process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
        mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_enabled: false };
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER, paymentMethodPreference: 'prepay_annual' });
        expect(p).toEqual({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
      });

      it('the same members with a per-application preference (or none) still move', async () => {
        live();
        process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
        mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_enabled: false };
        expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER, paymentMethodPreference: 'pay_at_visit' })).afterVisitCard).toBe(true);
        expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).afterVisitCard).toBe(true);
      });
    });

    // Explicit Auto Pay disable: detected by customers.autopay_enabled !== true
    // AND the latest autopay_log toggle row being autopay_disabled (the same
    // rule autopay-setup-link.js uses for its opt-out), held like the pause.
    describe('explicit Auto Pay disable (held cohort: card kept, never enrolled, never charged)', () => {
      const OFF_CUSTOMER = { ...PER_APP_CUSTOMER, autopay_enabled: false };

      it('explicitAutopayDisable: latest toggle disabled -> true; enabled / no rows / autopay on -> false', async () => {
        mockDbFixtures.autopay_log = { event_type: 'autopay_disabled' };
        expect(await explicitAutopayDisable(OFF_CUSTOMER)).toBe(true);
        mockDbFixtures.autopay_log = { event_type: 'autopay_enabled' };
        expect(await explicitAutopayDisable(OFF_CUSTOMER)).toBe(false);
        mockDbFixtures.autopay_log = null;
        expect(await explicitAutopayDisable(OFF_CUSTOMER)).toBe(false);
        mockDbFixtures.autopay_log = { event_type: 'autopay_disabled' };
        expect(await explicitAutopayDisable({ ...OFF_CUSTOMER, autopay_enabled: true })).toBe(false);
        expect(await explicitAutopayDisable(null)).toBe(false);
      });

      it('gate on: an eligible member who turned Auto Pay off keeps/captures the card with the held marker (no paused marker)', async () => {
        live();
        mockDbFixtures.customers = OFF_CUSTOMER;
        mockDbFixtures.autopay_log = { event_type: 'autopay_disabled' };
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
        expect(p).toEqual({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, customerId: 'cust-1', autopayDisabled: true });
        expect(afterVisitHeld(p)).toBe(true);
        expect(payAfterFirstVisitInvoiceRail(p)).toBe(true);
        expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
      });

      it('PAUSED and opted out (card detached during a pause): both markers kept, so the accept never enrolls the replacement card', async () => {
        live();
        mockDbFixtures.customers = { ...OFF_CUSTOMER, autopay_paused_until: '2099-01-01' };
        mockIsPaused.mockReturnValue(true);
        mockDbFixtures.autopay_log = { event_type: 'autopay_disabled' };
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
        expect(p).toEqual({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, customerId: 'cust-1', autopayPaused: true, autopayDisabled: true });
        // A paused non-member with an opt-out too.
        mockDbFixtures.customers = { id: 'cust-1', pipeline_stage: 'lead', billing_mode: null, monthly_rate: null, autopay_paused_until: '2099-01-01' };
        const nonMember = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
        expect(nonMember.autopayPaused).toBe(true);
        expect(nonMember.autopayDisabled).toBe(true);
      });

      it('a never-toggled (or re-enabled) non-autopay member is NOT held: normal moved cohort', async () => {
        live();
        mockDbFixtures.customers = OFF_CUSTOMER;
        mockDbFixtures.autopay_log = { event_type: 'autopay_enabled' };
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
        expect(p).toEqual({ enforced: true, required: true, exemptReason: null, afterVisitCard: true, customerId: 'cust-1' });
        expect(afterVisitHeld(p)).toBe(false);
      });

      it('a failed disable lookup fails closed to today\'s exemption (never moves, never enrolls)', async () => {
        live();
        mockDbFixtures.customers = OFF_CUSTOMER;
        mockDbFixtures.autopay_log = () => { throw new Error('log table down'); };
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
        expect(p).toEqual({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
      });

      it('a failed disable lookup for a PAUSED customer keeps today\'s autopay_paused exemption (member or non-member), never the capture lane', async () => {
        live();
        mockIsPaused.mockReturnValue(true);
        mockDbFixtures.autopay_log = () => { throw new Error('log table down'); };
        mockDbFixtures.customers = { ...OFF_CUSTOMER, autopay_paused_until: '2099-01-01' };
        expect(await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).toEqual({ enforced: true, required: false, exemptReason: 'autopay_paused' });
        mockDbFixtures.customers = { id: 'cust-1', pipeline_stage: 'lead', billing_mode: null, monthly_rate: null, autopay_paused_until: '2099-01-01' };
        expect(await resolveRecurringCardPolicyForEstimate({ estimate: EST })).toEqual({ enforced: true, required: false, exemptReason: 'autopay_paused' });
      });

      it('gate off: an Auto Pay opt-out changes nothing (today\'s existing_plan_customer)', async () => {
        mockDbFixtures.customers = OFF_CUSTOMER;
        mockDbFixtures.autopay_log = { event_type: 'autopay_disabled' };
        const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
        expect(p).toEqual({ enforced: true, required: false, exemptReason: 'existing_plan_customer' });
      });

      it('the monthly-membership lane stays exempt even with an opt-out (not eligible)', async () => {
        live();
        mockDbFixtures.customers = { ...MONTHLY_CUSTOMER, autopay_enabled: false };
        mockDbFixtures.autopay_log = { event_type: 'autopay_disabled' };
        expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER })).exemptReason).toBe('existing_plan_customer');
      });
    });

    // GitHub Codex #5481 r1 P1: eligibility is re-judged under the accept
    // transaction's customer lock; drift (billing_mode flip, pause / opt-out
    // change, no customer) aborts the accept rather than suppressing the pay
    // link and enrolling the card on a stale decision.
    describe('pafExistingDriftUnderLock (locked-row recheck)', () => {
      const trxFor = (customersRow, logRow = null) => {
        const chain = (row) => {
          const c = { first: async () => (typeof row === 'function' ? row() : row) };
          for (const m of ['where', 'whereIn', 'orderBy', 'forUpdate']) c[m] = () => c;
          return c;
        };
        return jest.fn((table) => chain(table === 'autopay_log' ? logRow : customersRow));
      };
      const MOVED = { afterVisitCard: true, customerId: 'cust-1' };

      it('no drift when the locked row still matches the preflight cohort', async () => {
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }), { customerId: 'cust-1', policy: MOVED })).toBe(false);
      });

      it('r8 drift: the saved method a saved_method_consented policy chose is gone or changed under the lock', async () => {
        const SAVED = { ...MOVED, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-row-1' };
        const ROW = { ...PER_APP_CUSTOMER, autopay_enabled: false };
        mockFindConsentedChargeableCard.mockResolvedValueOnce(null);
        expect(await pafExistingDriftUnderLock(trxFor(ROW), { customerId: 'cust-1', policy: SAVED })).toBe(true);
        mockFindConsentedChargeableCard.mockResolvedValueOnce({ id: 'pm-row-2' });
        expect(await pafExistingDriftUnderLock(trxFor(ROW), { customerId: 'cust-1', policy: SAVED })).toBe(true);
        // Still the same consented card: no drift (and it is row-locked until commit).
        mockFindConsentedChargeableCard.mockResolvedValueOnce({ id: 'pm-row-1' });
        const trx = jest.fn((table) => {
          const c = { first: async () => (table === 'payment_methods' ? { id: 'pm-row-1' } : (table === 'autopay_log' ? null : ROW)) };
          for (const m of ['where', 'whereIn', 'orderBy', 'forUpdate']) c[m] = () => c;
          return c;
        });
        expect(await pafExistingDriftUnderLock(trx, { customerId: 'cust-1', policy: SAVED })).toBe(false);
        expect(trx).toHaveBeenCalledWith('payment_methods');
      });

      it('r5 drift: Auto Pay turned ON (another tab) since the policy was resolved without it', async () => {
        mockCustomerOnAutopay.mockResolvedValue(true);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: true }), { customerId: 'cust-1', policy: MOVED })).toBe(true);
        // A held cohort is never auto-charged, so an active-looking state is not drift there.
        mockIsPaused.mockReturnValue(true);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: true }), { customerId: 'cust-1', policy: { ...MOVED, autopayPaused: true } })).toBe(false);
        mockIsPaused.mockReturnValue(false);
        // An unreadable method fails closed (treated as drift).
        mockCustomerOnAutopay.mockRejectedValue(new Error('pm read failed'));
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: true }), { customerId: 'cust-1', policy: MOVED })).toBe(true);
        mockCustomerOnAutopay.mockResolvedValue(false);
      });

      it('drift: billing_mode flipped to monthly_membership between preflight and the lock', async () => {
        expect(await pafExistingDriftUnderLock(trxFor(MONTHLY_CUSTOMER), { customerId: 'cust-1', policy: MOVED })).toBe(true);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, billing_mode: 'annual_prepay' }), { customerId: 'cust-1', policy: MOVED })).toBe(true);
      });

      it('drift: pause started / ended, or an opt-out landed / was reversed', async () => {
        mockIsPaused.mockReturnValue(true);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }), { customerId: 'cust-1', policy: MOVED })).toBe(true);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }), { customerId: 'cust-1', policy: { ...MOVED, autopayPaused: true } })).toBe(false);
        mockIsPaused.mockReturnValue(false);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }, { event_type: 'autopay_disabled' }), { customerId: 'cust-1', policy: MOVED })).toBe(true);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }, { event_type: 'autopay_disabled' }), { customerId: 'cust-1', policy: { ...MOVED, autopayDisabled: true } })).toBe(false);
        expect(await pafExistingDriftUnderLock(trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }, { event_type: 'autopay_enabled' }), { customerId: 'cust-1', policy: { ...MOVED, autopayDisabled: true } })).toBe(true);
        // Paused AND opted out: the opt-out is judged independently of the pause.
        mockIsPaused.mockReturnValue(true);
        const pausedOptedOut = trxFor({ ...PER_APP_CUSTOMER, autopay_enabled: false }, { event_type: 'autopay_disabled' });
        expect(await pafExistingDriftUnderLock(pausedOptedOut, { customerId: 'cust-1', policy: { ...MOVED, autopayPaused: true, autopayDisabled: true } })).toBe(false);
        expect(await pafExistingDriftUnderLock(pausedOptedOut, { customerId: 'cust-1', policy: { ...MOVED, autopayPaused: true } })).toBe(true);
      });

      // GitHub Codex #5481 r2 P1: the locked recheck must run against the SAME
      // customer the preflight resolver judged (phone-matched / grouped sibling).
      it('drift: the accept transaction landed on a DIFFERENT customer than the resolver judged (or the policy carries no customer)', async () => {
        const row = { ...PER_APP_CUSTOMER, autopay_enabled: false };
        expect(await pafExistingDriftUnderLock(trxFor(row), { customerId: 'cust-2', policy: MOVED })).toBe(true);
        expect(await pafExistingDriftUnderLock(trxFor(row), { customerId: 'cust-1', policy: { afterVisitCard: true } })).toBe(true);
        // numeric vs string ids compare equal (same row)
        expect(await pafExistingDriftUnderLock(trxFor(row), { customerId: 7, policy: { afterVisitCard: true, customerId: '7' } })).toBe(false);
      });

      it('mismatch is judged BEFORE the locked read (never locks the wrong profile)', async () => {
        const trx = trxFor(PER_APP_CUSTOMER);
        expect(await pafExistingDriftUnderLock(trx, { customerId: 'cust-2', policy: MOVED })).toBe(true);
        expect(trx).not.toHaveBeenCalled();
      });

      it('fails closed: no customer, missing row, lookup error', async () => {
        expect(await pafExistingDriftUnderLock(trxFor(PER_APP_CUSTOMER), { customerId: null, policy: MOVED })).toBe(true);
        expect(await pafExistingDriftUnderLock(trxFor(null), { customerId: 'cust-1', policy: MOVED })).toBe(true);
        expect(await pafExistingDriftUnderLock(trxFor(() => { throw new Error('boom'); }), { customerId: 'cust-1', policy: MOVED })).toBe(true);
      });

      it('never fires for a policy that is not the moved cohort', async () => {
        const trx = trxFor(MONTHLY_CUSTOMER);
        expect(await pafExistingDriftUnderLock(trx, { customerId: 'cust-1', policy: { enforced: true, required: true, exemptReason: null } })).toBe(false);
        expect(trx).not.toHaveBeenCalled();
      });
    });

    describe('applyCommercialManualBillingExemption (every card-rail shape)', () => {
      it('clears the saved-method auto-satisfy shape of the moved cohort (required:false escaped the old required-only check)', () => {
        const p = { enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-1', afterVisitCard: true, autopayPaused: true };
        applyCommercialManualBillingExemption(p, { commercialManualBilling: true });
        expect(p).toEqual({ enforced: true, required: false, exemptReason: 'commercial_manual_billing' });
        expect(payAfterFirstVisitInvoiceRail(p)).toBe(false);
      });

      it('clears the capture-required shape, including the held markers', () => {
        const p = { enforced: true, required: true, exemptReason: null, afterVisitCard: true, autopayDisabled: true };
        applyCommercialManualBillingExemption(p, { commercialManualBilling: true });
        expect(p).toEqual({ enforced: true, required: false, exemptReason: 'commercial_manual_billing' });
        const plain = { enforced: true, required: true, exemptReason: null };
        applyCommercialManualBillingExemption(plain, { commercialManualBilling: true });
        expect(plain).toEqual({ enforced: true, required: false, exemptReason: 'commercial_manual_billing' });
      });

      it('leaves everything else alone: not commercial, a non-moved saved-method policy, an exempt policy', () => {
        const moved = { enforced: true, required: true, exemptReason: null, afterVisitCard: true };
        applyCommercialManualBillingExemption(moved, { commercialManualBilling: false });
        expect(moved).toEqual({ enforced: true, required: true, exemptReason: null, afterVisitCard: true });
        const saved = { enforced: true, required: false, exemptReason: 'saved_method_consented', savedMethodRowId: 'pm-1' };
        applyCommercialManualBillingExemption(saved, { commercialManualBilling: true });
        expect(saved.exemptReason).toBe('saved_method_consented');
        const exempt = { enforced: true, required: false, exemptReason: 'payer_billed' };
        applyCommercialManualBillingExemption(exempt, { commercialManualBilling: true });
        expect(exempt.exemptReason).toBe('payer_billed');
      });
    });

    it('gate on: a label-only (auto tier) customer is not a member and is unaffected (still the normal required lane, no marker)', async () => {
      live();
      mockTierLabelStatus.mockResolvedValueOnce('label');
      mockDbFixtures.customers = { ...PER_APP_CUSTOMER, autopay_enabled: false };
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, membership: MEMBER });
      expect(p).toEqual({ enforced: true, required: true, exemptReason: null });
    });
  });

  it('keeps the card REQUIRED when the live plan check fails (fail toward protection)', async () => {
    mockQualifyingRows.mockRejectedValue(new Error('db down'));
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.required).toBe(true);
  });

  it('exempts payer-billed customers (never auto-charge the homeowner for payer invoices)', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST, scheduledServiceId: 'ss-9', useLinkedFallback: false });
    expect(p.exemptReason).toBe('payer_billed');
    // throwOnError is load-bearing: resolveForInvoice is fail-soft by default,
    // and a soft self-pay result on a lookup outage would enroll the wrong
    // party (Codex #2668 round-4 P1).
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-1', scheduledServiceId: 'ss-9', throwOnError: true });
  });

  it('EXEMPTS the card when the payer check fails (uncertain payer must never enroll the wrong party)', async () => {
    mockResolveForInvoice.mockRejectedValue(new Error('payer svc down'));
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.required).toBe(false);
    expect(p.exemptReason).toBe('payer_check_uncertain');
  });

  it('exempts a customer already on Auto Pay with a chargeable method', async () => {
    mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true };
    mockCustomerOnAutopay.mockResolvedValue(true);
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.exemptReason).toBe('autopay_already_active');
  });

  // Codex #3492 r12: an ACTIVE pause is the customer's explicit "don't
  // auto-charge" — the paused cohort must classify OUT of the auto-satisfy
  // lane (no charge-at-confirm promise, no capture demand), even when a
  // consented saved card exists that would otherwise auto-satisfy.
  it('classifies an autopay-PAUSED customer outside the charge lane (no auto-satisfy, no capture)', async () => {
    mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true, autopay_paused_until: '2099-01-01' };
    mockIsPaused.mockReturnValue(true);
    mockCustomerOnAutopay.mockResolvedValue(false);
    mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pm-row-1' });
    try {
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
      expect(p.exemptReason).toBe('autopay_paused');
      expect(p.required).toBe(false);
    } finally {
      mockIsPaused.mockReturnValue(false);
    }
  });

  it('auto-satisfies with a saved consented card (spec §3.2 — never re-ask) and surfaces its row id', async () => {
    mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pmrow-7', stripe_payment_method_id: 'pm_7' });
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.required).toBe(false);
    expect(p.exemptReason).toBe('saved_method_consented');
    expect(p.savedMethodRowId).toBe('pmrow-7');
  });

  it('keeps the card required when the saved-method lookup fails (fail toward protection)', async () => {
    mockFindConsentedChargeableCard.mockRejectedValue(new Error('consents down'));
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.required).toBe(true);
  });

  it('requires the card for a plain new recurring accept (and with no linked customer)', async () => {
    expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST })).required).toBe(true);
    expect((await resolveRecurringCardPolicyForEstimate({ estimate: { id: 'est-2', customer_id: null } })).required).toBe(true);
  });

  // Codex #3492 r25: the accept transaction links an unlinked grouped
  // estimate through an accepted SIBLING before any phone matching, so the
  // policy's customer-dependent exemptions must see the sibling's owner —
  // not "no customer" (which would demand a SetupIntent the standing
  // exemption waives) and not a different shared-phone profile.
  describe('grouped multi-property owner resolution', () => {
    const GROUPED = { id: 'est-g1', customer_id: null, estimate_group_id: 'grp-1' };

    it("honors the grouped sibling owner's saved-card exemption (no re-ask)", async () => {
      mockDbFixtures.estimates = { customer_id: 'cust-sib' };
      mockDbFixtures.customers = { id: 'cust-sib' };
      mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pmrow-sib', stripe_payment_method_id: 'pm_sib' });
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: GROUPED });
      expect(p.required).toBe(false);
      expect(p.exemptReason).toBe('saved_method_consented');
      expect(p.savedMethodRowId).toBe('pmrow-sib');
      expect(mockFindConsentedChargeableCard).toHaveBeenCalledWith('cust-sib');
    });

    it('keeps the card required when no sibling has resolved a customer yet', async () => {
      mockDbFixtures.estimates = null;
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: GROUPED });
      expect(p.required).toBe(true);
    });

    it('keeps the card required when the sibling owner is soft-deleted (helper returns null)', async () => {
      mockDbFixtures.estimates = { customer_id: 'cust-gone' };
      mockDbFixtures.customers = null;
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: GROUPED });
      expect(p.required).toBe(true);
    });

    it('fails soft on a sibling lookup error — card stays required, no throw', async () => {
      mockDbFixtures.estimates = () => { throw new Error('db down'); };
      const p = await resolveRecurringCardPolicyForEstimate({ estimate: GROUPED });
      expect(p.required).toBe(true);
    });
  });
});

describe('verifyRecurringCardIntent (trust boundary)', () => {
  it('rejects a missing setupIntentId', async () => {
    const r = await verifyRecurringCardIntent({ estimate: EST, setupIntentId: '' });
    expect(r).toEqual({ ok: false, reason: 'no_setup_intent' });
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
  });

  it('fails closed when the live retrieval errors', async () => {
    mockRetrieveSetupIntent.mockRejectedValue(new Error('stripe down'));
    const r = await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' });
    expect(r).toEqual({ ok: false, reason: 'verification_failed' });
  });

  it.each([
    ['a one-time HOLD intent (wrong purpose)', { ...GOOD_SI, metadata: { purpose: 'estimate_card_hold', estimate_id: 'est-1' } }],
    ['another estimate\'s intent', { ...GOOD_SI, metadata: { ...GOOD_SI.metadata, estimate_id: 'est-OTHER' } }],
    ['a non-succeeded intent', { ...GOOD_SI, status: 'requires_payment_method' }],
    ['an intent with no payment method', { ...GOOD_SI, payment_method: null }],
  ])('rejects %s', async (_label, si) => {
    mockRetrieveSetupIntent.mockResolvedValue(si);
    const r = await verifyRecurringCardIntent({ estimate: EST, setupIntentId: si.id });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('intent_mismatch');
  });

  it('accepts a live succeeded intent pinned to this estimate (string or expanded pm)', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    expect(await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' }))
      .toEqual({ ok: true, paymentMethodId: 'pm_1', setupIntentId: 'seti_1', methodType: 'card' });
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, payment_method: { id: 'pm_9' } });
    expect((await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).paymentMethodId).toBe('pm_9');
  });

  it('matcher pins purpose + estimate + status + pm', () => {
    expect(recurringCardIntentMatchesEstimate(GOOD_SI, 'est-1')).toBe(true);
    expect(recurringCardIntentMatchesEstimate(null, 'est-1')).toBe(false);
  });

  // "Use a different payment method" (customer report 2026-09-08): a
  // succeeded capture the customer retired must never be the one the accept
  // enrolls, even though Stripe still reports it succeeded.
  it('refuses a retired (replaced) succeeded intent', async () => {
    const retired = { ...GOOD_SI, metadata: { ...GOOD_SI.metadata, retired: 'true' } };
    expect(recurringCardIntentMatchesEstimate(retired, 'est-1')).toBe(false);
    mockRetrieveSetupIntent.mockResolvedValue(retired);
    expect(await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' }))
      .toEqual({ ok: false, reason: 'intent_mismatch' });
  });

  // The accept re-reads the intent under its row lock (pre-push Codex P1
  // r3): a retirement that landed between the pre-transaction verify and
  // the commit aborts the accept instead of enrolling the retired method.
  it('verifyRecurringCardIntentUnderLock refuses a retired or non-succeeded intent and fails closed on a read error', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    expect(await verifyRecurringCardIntentUnderLock({ setupIntentId: 'seti_1' })).toBe(true);
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, metadata: { ...GOOD_SI.metadata, retired: 'true' } });
    expect(await verifyRecurringCardIntentUnderLock({ setupIntentId: 'seti_1' })).toBe(false);
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, status: 'canceled' });
    expect(await verifyRecurringCardIntentUnderLock({ setupIntentId: 'seti_1' })).toBe(false);
    mockRetrieveSetupIntent.mockRejectedValue(new Error('stripe down'));
    expect(await verifyRecurringCardIntentUnderLock({ setupIntentId: 'seti_1' })).toBe(false);
    expect(await verifyRecurringCardIntentUnderLock({ setupIntentId: '' })).toBe(false);
  });

  // Kill switch at the trust boundary (pre-push Codex P1): a bank-capable
  // intent minted while GATE_ACCEPT_ACH_CAPTURE was on must not accept a bank
  // method once the gate is off or the customer's ACH state turned unhealthy.
  describe('bank method re-validation (GATE_ACCEPT_ACH_CAPTURE)', () => {
    const gates = require('../config/feature-gates').gates;
    const BANK_SI = { ...GOOD_SI, payment_method_types: ['card', 'us_bank_account'] };
    afterEach(() => { gates.acceptAchCapture = false; });

    it('accepts a bank method while the gate is on and the customer ACH state is healthy', async () => {
      gates.acceptAchCapture = true;
      mockDbFixtures.customers = { ach_status: 'active' };
      mockRetrieveSetupIntent.mockResolvedValue({ ...BANK_SI, payment_method: { id: 'pm_b', type: 'us_bank_account' } });
      expect(await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' }))
        .toEqual({ ok: true, paymentMethodId: 'pm_b', setupIntentId: 'seti_1', methodType: 'us_bank_account' });
      expect(mockRetrievePaymentMethod).not.toHaveBeenCalled();
    });

    it('resolves a string pm on a bank-capable intent via Stripe before judging it', async () => {
      gates.acceptAchCapture = true;
      mockRetrieveSetupIntent.mockResolvedValue({ ...BANK_SI, payment_method: 'pm_c' });
      mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_c', type: 'card', card: { funding: 'debit' } });
      expect((await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).ok).toBe(true);
      expect(mockRetrievePaymentMethod).toHaveBeenCalledWith('pm_c');
    });

    it('refuses a bank method once the gate is OFF (intent minted earlier)', async () => {
      gates.acceptAchCapture = false;
      mockRetrieveSetupIntent.mockResolvedValue({ ...BANK_SI, payment_method: { id: 'pm_b', type: 'us_bank_account' } });
      expect(await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' }))
        .toEqual({ ok: false, reason: 'bank_not_allowed' });
    });

    it('refuses a bank method when the customer ACH state is unhealthy at accept', async () => {
      gates.acceptAchCapture = true;
      mockDbFixtures.customers = { ach_status: 'needs_verification' };
      mockRetrieveSetupIntent.mockResolvedValue({ ...BANK_SI, payment_method: 'pm_b' });
      mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_b', type: 'us_bank_account' });
      expect((await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).reason).toBe('bank_not_allowed');
    });

    it('still accepts a CARD on a bank-capable intent with the gate off', async () => {
      gates.acceptAchCapture = false;
      mockRetrieveSetupIntent.mockResolvedValue({ ...BANK_SI, payment_method: { id: 'pm_k', type: 'card' } });
      expect((await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).ok).toBe(true);
    });

    it('fails closed when the payment method lookup errors', async () => {
      gates.acceptAchCapture = true;
      mockRetrieveSetupIntent.mockResolvedValue({ ...BANK_SI, payment_method: 'pm_x' });
      mockRetrievePaymentMethod.mockRejectedValue(new Error('stripe down'));
      expect((await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).reason).toBe('verification_failed');
    });

    // In-transaction re-judgement (Codex #3723 r3 P1): the accept re-checks
    // the bank against the customer it LANDED on, under that customer's lock.
    describe('bankTenderAllowedUnderLock', () => {
      // The judgement must take the row lock (r4 P1) — the fake trx only
      // resolves through forUpdate().
      const trxFor = (row, fail = false) => (() => ({ where: () => ({ forUpdate: () => ({ first: async () => { if (fail) throw new Error('db down'); return row; } }) }) }));
      it('always allows a card', async () => {
        gates.acceptAchCapture = false;
        expect(await bankTenderAllowedUnderLock(trxFor(null), { customerId: 'c1', methodType: 'card' })).toBe(true);
      });
      it('allows a bank only with the gate on and a healthy customer', async () => {
        gates.acceptAchCapture = true;
        expect(await bankTenderAllowedUnderLock(trxFor({ ach_status: null }), { customerId: 'c1', methodType: 'us_bank_account' })).toBe(true);
        expect(await bankTenderAllowedUnderLock(trxFor({ ach_status: 'active' }), { customerId: 'c1', methodType: 'us_bank_account' })).toBe(true);
        expect(await bankTenderAllowedUnderLock(trxFor({ ach_status: 'suspended' }), { customerId: 'c1', methodType: 'us_bank_account' })).toBe(false);
        gates.acceptAchCapture = false;
        expect(await bankTenderAllowedUnderLock(trxFor({ ach_status: 'active' }), { customerId: 'c1', methodType: 'us_bank_account' })).toBe(false);
      });
      it('fails closed on an unknown tender, a missing customer, or a lookup error', async () => {
        gates.acceptAchCapture = true;
        expect(await bankTenderAllowedUnderLock(trxFor({ ach_status: null }), { customerId: 'c1', methodType: 'unknown' })).toBe(false);
        expect(await bankTenderAllowedUnderLock(trxFor({ ach_status: null }), { customerId: null, methodType: 'us_bank_account' })).toBe(false);
        expect(await bankTenderAllowedUnderLock(trxFor(null, true), { customerId: 'c1', methodType: 'us_bank_account' })).toBe(false);
      });
    });
  });
});

describe('markAfterVisitCaptureIntent (PAF-B r3 pre-push P0 — capture provenance at mint)', () => {
  const { markAfterVisitCaptureIntent } = require('../services/recurring-card-on-file');
  it('stamps the intent through Stripe metadata; a failed stamp is ok:false (the mint route offers no capture)', async () => {
    mockMarkAfterVisit.mockResolvedValueOnce({});
    expect(await markAfterVisitCaptureIntent('seti_1')).toEqual({ ok: true });
    expect(mockMarkAfterVisit).toHaveBeenCalledWith('seti_1');
    mockMarkAfterVisit.mockRejectedValueOnce(new Error('stripe down'));
    expect(await markAfterVisitCaptureIntent('seti_1')).toEqual({ ok: false, reason: 'stamp_failed' });
    expect(await markAfterVisitCaptureIntent('')).toEqual({ ok: false, reason: 'no_setup_intent' });
  });
});

describe('retireOrphanedCaptureIntent (PAF-B r3 pre-push P0)', () => {
  const { retireOrphanedCaptureIntent } = require('../services/recurring-card-on-file');
  const LIVE = { ...GOOD_SI, payment_method: { id: 'pm_1', type: 'card' } };
  const liveById = (map) => mockRetrieveSetupIntent.mockImplementation(async (id) => map[id] || null);

  it('retires this estimate\'s succeeded intent (metadata.retired, no replacement)', async () => {
    liveById({ seti_1: LIVE });
    mockRetireSetupIntent.mockResolvedValue({});
    expect(await retireOrphanedCaptureIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: true, retired: true });
    expect(mockRetireSetupIntent).toHaveBeenCalledWith('seti_1');
  });

  it.each([
    ['another estimate\'s intent', { ...LIVE, metadata: { ...GOOD_SI.metadata, estimate_id: 'est-OTHER' } }],
    ['a one-time HOLD intent', { ...LIVE, metadata: { purpose: 'estimate_card_hold', estimate_id: 'est-1' } }],
    ['an already-retired intent', { ...LIVE, metadata: { ...GOOD_SI.metadata, retired: 'true' } }],
    ['a canceled intent', { ...LIVE, status: 'canceled' }],
  ])('leaves %s alone', async (_label, si) => {
    liveById({ [si.id]: si });
    expect(await retireOrphanedCaptureIntent({ estimate: EST, setupIntentId: si.id })).toEqual({ ok: true, retired: false });
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
  });

  it('an id Stripe never minted needs nothing; an outage or a failed stamp is ok:false (caller fails closed)', async () => {
    mockRetrieveSetupIntent.mockRejectedValueOnce(Object.assign(new Error('No such setupintent'), { code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError' }));
    expect(await retireOrphanedCaptureIntent({ estimate: EST, setupIntentId: 'seti_nope' })).toEqual({ ok: true, retired: false });
    mockRetrieveSetupIntent.mockRejectedValueOnce(Object.assign(new Error('Stripe is down'), { statusCode: 503, type: 'StripeAPIError' }));
    expect(await retireOrphanedCaptureIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'verification_failed' });
    liveById({ seti_1: LIVE });
    mockRetireSetupIntent.mockRejectedValueOnce(new Error('stripe write failed'));
    expect(await retireOrphanedCaptureIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'retire_failed' });
  });
});

describe('replaceRecurringCardIntent ("use a different payment method")', () => {
  const LIVE_GOOD = { ...GOOD_SI, payment_method: { id: 'pm_1', type: 'card' }, client_secret: 'cs_1' };
  const FRESH = { id: 'seti_after', client_secret: 'cs_after', status: 'requires_payment_method', metadata: { purpose: 'estimate_recurring_card', estimate_id: 'est-1' } };
  const liveById = (map) => mockRetrieveSetupIntent.mockImplementation(async (id) => map[id] || null);
  const db = require('../models/db');
  beforeEach(() => { mockDbFixtures.estimates = { id: 'est-1', status: 'viewed', accepted_at: null }; });

  it('mints the replacement FIRST (keyed on the retired id), then stamps the old intent retired + replaced_by — under the estimate row lock', async () => {
    liveById({ seti_1: LIVE_GOOD, seti_after: FRESH });
    mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
    mockRetireSetupIntent.mockResolvedValue({ ...LIVE_GOOD, metadata: { ...LIVE_GOOD.metadata, retired: 'true', replaced_by: 'seti_after' } });
    const r = await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' });
    expect(r).toEqual({
      ok: true,
      retired: true,
      intent: { clientSecret: 'cs_after', setupIntentId: 'seti_after', paymentMethodTypes: ['card'], capturedMethodType: null },
    });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledWith({ estimateId: 'est-1', paymentMethodType: 'card', replacing: 'seti_1' });
    expect(mockRetireSetupIntent).toHaveBeenCalledWith('seti_1', { replacedBy: 'seti_after' });
    // Ordering: the stamp lands only after the replacement exists.
    expect(mockCreateRecurringCardSetupIntent.mock.invocationCallOrder[0]).toBeLessThan(mockRetireSetupIntent.mock.invocationCallOrder[0]);
    // Serialized with the accept: the retire ran inside a transaction that
    // locked the estimate row (the accept's guarded UPDATE holds the same lock).
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  // Pre-push Codex P1 r3: an accept that committed while this waited for
  // the row lock must find nothing to retire — its enrolled method stays.
  it('refuses once the estimate is accepted under the lock, retiring nothing', async () => {
    liveById({ seti_1: LIVE_GOOD, seti_after: FRESH });
    mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
    mockDbFixtures.estimates = { id: 'est-1', status: 'accepted', accepted_at: '2026-09-08T15:00:00Z' };
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'estimate_accepted' });
    expect(mockCreateRecurringCardSetupIntent).not.toHaveBeenCalled();
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['another estimate\'s intent', { ...LIVE_GOOD, metadata: { ...GOOD_SI.metadata, estimate_id: 'est-OTHER' } }],
    ['a one-time HOLD intent', { ...LIVE_GOOD, metadata: { purpose: 'estimate_card_hold', estimate_id: 'est-1' } }],
  ])('refuses %s without minting or retiring anything', async (_label, si) => {
    liveById({ [si.id]: si });
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: si.id })).toEqual({ ok: false, reason: 'intent_mismatch' });
    expect(mockCreateRecurringCardSetupIntent).not.toHaveBeenCalled();
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
  });

  // GitHub Codex #4144 r1: an id Stripe has never minted is the client's
  // error (400 like any other mismatch), not a retryable Stripe failure.
  it('classifies a Stripe resource_missing lookup as a mismatch, and any other lookup error as a verification failure', async () => {
    mockRetrieveSetupIntent.mockRejectedValueOnce(Object.assign(new Error("No such setupintent: 'seti_nope'"), { code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError' }));
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_nope' })).toEqual({ ok: false, reason: 'intent_mismatch' });
    mockRetrieveSetupIntent.mockRejectedValueOnce(Object.assign(new Error('Stripe is down'), { statusCode: 503, type: 'StripeAPIError' }));
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'verification_failed' });
    expect(mockCreateRecurringCardSetupIntent).not.toHaveBeenCalled();
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
  });

  it('hands back the ordinary mint for a not-yet-confirmed or already-retired intent (nothing to retire)', async () => {
    const open = { ...LIVE_GOOD, status: 'requires_payment_method', payment_method: null };
    liveById({ seti_1: open });
    mockCreateRecurringCardSetupIntent.mockResolvedValue(open);
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({
      ok: true,
      retired: false,
      intent: { clientSecret: 'cs_1', setupIntentId: 'seti_1', paymentMethodTypes: ['card'], capturedMethodType: null },
    });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledWith({ estimateId: 'est-1', generation: 0, paymentMethodType: 'card' });
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
    // Even the nothing-to-retire outcome runs under the estimate row lock.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  // GitHub Codex #4144 r1 P0: a stale tab retrying with an intent that was
  // already retired (or never confirmed) must not mint a fresh capture for
  // an estimate another tab accepted meanwhile — same lock, same 409.
  it('refuses a stale retry (already-retired or unfinished intent) once the estimate is accepted under the lock', async () => {
    const retired = { ...LIVE_GOOD, metadata: { ...LIVE_GOOD.metadata, retired: 'true', replaced_by: 'seti_after' } };
    liveById({ seti_1: retired, seti_after: FRESH });
    mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
    mockDbFixtures.estimates = { id: 'est-1', status: 'accepted', accepted_at: '2026-09-08T15:00:00Z' };
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'estimate_accepted' });
    const open = { ...LIVE_GOOD, status: 'requires_payment_method', payment_method: null };
    liveById({ seti_1: open });
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'estimate_accepted' });
    expect(mockCreateRecurringCardSetupIntent).not.toHaveBeenCalled();
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  // GitHub Codex #4144 r2 P2: the tender lookups inside the locked
  // transaction ride its pinned connection — a replacement waiting on the
  // estimate row must not also wait on the pool for a second connection.
  it('reads the customer ACH state through the transaction handle, not the module db', async () => {
    const gates = require('../config/feature-gates').gates;
    gates.acceptAchCapture = true;
    try {
      mockDbFixtures.customers = { ach_status: 'active' };
      liveById({ seti_1: LIVE_GOOD, seti_after: { ...FRESH, payment_method_types: ['card', 'us_bank_account'] } });
      mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
      mockRetireSetupIntent.mockResolvedValue({ ...LIVE_GOOD, metadata: { ...LIVE_GOOD.metadata, retired: 'true', replaced_by: 'seti_after' } });
      const r = await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' });
      expect(r.ok).toBe(true);
      expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledWith({ estimateId: 'est-1', paymentMethodType: 'card_or_bank', replacing: 'seti_1' });
      expect(db.__lastTrx).toHaveBeenCalledWith('customers');
      expect(db.mock.calls.filter(([table]) => table === 'customers')).toHaveLength(0);
    } finally {
      gates.acceptAchCapture = false;
    }
  });

  // GitHub Codex #4144 r4 P2: the phone-match fallback for an unlinked
  // estimate rides the same handle.
  it('passes the transaction handle through the phone-match fallback for an unlinked estimate', async () => {
    const gates = require('../config/feature-gates').gates;
    gates.acceptAchCapture = true;
    try {
      const UNLINKED = { id: 'est-1', customer_id: null, customer_phone: '9415551234' };
      mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: null });
      liveById({ seti_1: { ...LIVE_GOOD, metadata: { ...LIVE_GOOD.metadata, estimate_id: 'est-1' } }, seti_after: FRESH });
      mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
      mockRetireSetupIntent.mockResolvedValue({ ...LIVE_GOOD, metadata: { ...LIVE_GOOD.metadata, retired: 'true', replaced_by: 'seti_after' } });
      expect((await replaceRecurringCardIntent({ estimate: UNLINKED, setupIntentId: 'seti_1' })).ok).toBe(true);
      expect(mockMatchAcceptCustomerByPhone).toHaveBeenCalledWith(UNLINKED, db.__lastTrx);
    } finally {
      gates.acceptAchCapture = false;
    }
  });

  // GitHub Codex #4144 r2 P0: accepted is not the only terminal state — a
  // decline, expiry or archive that landed after the route's pre-read must
  // also refuse under the lock, before anything is minted or retired.
  it.each([
    ['declined', { id: 'est-1', status: 'declined', accepted_at: null }],
    ['expired by status', { id: 'est-1', status: 'expired', accepted_at: null }],
    ['expired by date', { id: 'est-1', status: 'viewed', accepted_at: null, expires_at: '2020-01-01T00:00:00Z' }],
    ['archived', { id: 'est-1', status: 'viewed', accepted_at: null, archived_at: '2026-09-08T15:00:00Z' }],
  ])('refuses under the lock once the estimate is %s, minting and retiring nothing', async (_label, row) => {
    liveById({ seti_1: LIVE_GOOD, seti_after: FRESH });
    mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
    mockDbFixtures.estimates = row;
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'estimate_inactive' });
    const retired = { ...LIVE_GOOD, metadata: { ...LIVE_GOOD.metadata, retired: 'true', replaced_by: 'seti_after' } };
    liveById({ seti_1: retired, seti_after: FRESH });
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'estimate_inactive' });
    expect(mockCreateRecurringCardSetupIntent).not.toHaveBeenCalled();
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
  });

  it('leaves the saved method untouched when the replacement cannot be minted (mint-first ordering)', async () => {
    liveById({ seti_1: LIVE_GOOD });
    mockCreateRecurringCardSetupIntent.mockRejectedValue(new Error('stripe down'));
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'mint_failed' });
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_dead', client_secret: 'cs_dead' });
    liveById({ seti_1: LIVE_GOOD, seti_dead: { id: 'seti_dead', status: 'canceled', metadata: {} } });
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'mint_failed' });
    expect(mockRetireSetupIntent).not.toHaveBeenCalled();
  });

  it('fails closed when the lookup or the stamp fails', async () => {
    mockRetrieveSetupIntent.mockRejectedValue(new Error('stripe down'));
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'verification_failed' });
    liveById({ seti_1: LIVE_GOOD, seti_after: FRESH });
    mockCreateRecurringCardSetupIntent.mockResolvedValue(FRESH);
    mockRetireSetupIntent.mockRejectedValue(new Error('stripe down'));
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).toEqual({ ok: false, reason: 'retire_failed' });
  });

  it('rejects a missing id', async () => {
    expect(await replaceRecurringCardIntent({ estimate: EST, setupIntentId: '' })).toEqual({ ok: false, reason: 'no_setup_intent' });
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
  });
});

describe('createRecurringCardSetupIntentForEstimate', () => {
  // The mint re-reads every created intent LIVE by id (an idempotent replay
  // returns the original create body). Default: the live object IS the
  // create body — tests that need drift override retrieve explicitly.
  let liveById;
  beforeEach(() => {
    liveById = new Map();
    mockRetrieveSetupIntent.mockImplementation(async (id) => {
      if (liveById.has(id)) return liveById.get(id);
      // Latest create wins (a test may re-mint the same id with new state).
      for (const r of [...mockCreateRecurringCardSetupIntent.mock.results].reverse()) {
        const created = await r.value;
        if (created?.id === id) return created;
      }
      return null;
    });
  });

  it('returns null when Stripe is not configured', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue(null);
    expect(await createRecurringCardSetupIntentForEstimate(EST)).toBeNull();
  });

  // Pre-push Codex P1 on this PR: Stripe's idempotent replay returns the
  // ORIGINAL create response, so a capture that has since succeeded (or
  // been retired) still reads requires_payment_method from the create — the
  // live read is what every judgement below must run on.
  it('judges the LIVE intent, not the cached create body (idempotent replay)', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'requires_payment_method' });
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'succeeded', payment_method: { id: 'pm_1', type: 'card' }, metadata: {} });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_1', setupIntentId: 'seti_1', paymentMethodTypes: ['card'], capturedMethodType: 'card' });
    expect(mockRetrieveSetupIntent).toHaveBeenCalledWith('seti_1', { expand: ['payment_method'] });
  });

  it('fails closed (no capture offered) when the live read fails', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'requires_payment_method' });
    mockRetrieveSetupIntent.mockRejectedValue(new Error('stripe down'));
    expect(await createRecurringCardSetupIntentForEstimate(EST)).toBeNull();
  });

  it('returns the client secret for the capture UI (card-only while GATE_ACCEPT_ACH_CAPTURE is off)', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'requires_payment_method' });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_1', setupIntentId: 'seti_1', paymentMethodTypes: ['card'], capturedMethodType: null });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledWith({ estimateId: 'est-1', generation: 0, paymentMethodType: 'card' });
  });

  it('walks the generation salt past a canceled replay (Codex #2668 P2)', async () => {
    mockCreateRecurringCardSetupIntent
      .mockResolvedValueOnce({ id: 'seti_dead', client_secret: 'cs_dead', status: 'canceled' })
      .mockResolvedValueOnce({ id: 'seti_2', client_secret: 'cs_2', status: 'requires_payment_method' });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_2', setupIntentId: 'seti_2', paymentMethodTypes: ['card'], capturedMethodType: null });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenNthCalledWith(1, { estimateId: 'est-1', generation: 0, paymentMethodType: 'card' });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenNthCalledWith(2, { estimateId: 'est-1', generation: 1, paymentMethodType: 'card' });
  });

  // A retired capture replays succeeded forever under the deterministic
  // key — the mint follows its `replaced_by` chain to the live capture, so
  // a refresh after "use a different payment method" lands on the
  // replacement (unbounded: no generation is consumed per replacement).
  it('follows a retired replay\'s replaced_by chain to the live head', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method' });
    liveById.set('seti_old', { id: 'seti_old', status: 'succeeded', payment_method: 'pm_old', metadata: { retired: 'true', replaced_by: 'seti_b' } });
    liveById.set('seti_b', { id: 'seti_b', status: 'succeeded', payment_method: { id: 'pm_b', type: 'us_bank_account' }, metadata: { retired: 'true', replaced_by: 'seti_c' } });
    liveById.set('seti_c', { id: 'seti_c', client_secret: 'cs_c', status: 'succeeded', payment_method: { id: 'pm_c', type: 'card' }, metadata: {} });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_c', setupIntentId: 'seti_c', paymentMethodTypes: ['card'], capturedMethodType: 'card' });
    // One generation only: the chain, not the salt, found the head.
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledTimes(1);
  });

  // Pre-push Codex P1 r3: a head minted bank-capable while the ACH gate was
  // on must not be handed back under a card-only policy (it would advertise
  // ['card'] over a saved bank the accept refuses, forever).
  it('walks to a compatible generation when the chain head\'s tender no longer matches the policy', async () => {
    mockCreateRecurringCardSetupIntent
      .mockResolvedValueOnce({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method' })
      .mockResolvedValueOnce({ id: 'seti_2', client_secret: 'cs_2', status: 'requires_payment_method', payment_method_types: ['card'] });
    liveById.set('seti_old', { id: 'seti_old', status: 'succeeded', payment_method: 'pm_old', payment_method_types: ['card'], metadata: { retired: 'true', replaced_by: 'seti_bank' } });
    liveById.set('seti_bank', { id: 'seti_bank', client_secret: 'cs_bank', status: 'succeeded', payment_method: { id: 'pm_b', type: 'us_bank_account' }, payment_method_types: ['card', 'us_bank_account'], metadata: {} });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_2', setupIntentId: 'seti_2', paymentMethodTypes: ['card'], capturedMethodType: null });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenNthCalledWith(2, { estimateId: 'est-1', generation: 1, paymentMethodType: 'card' });
  });

  // GitHub Codex #4144 r1 P2: a succeeded head is judged by what it captured,
  // like the accept gate — a CARD saved on a bank-capable intent is still a
  // valid card after the ACH gate closes; only a captured bank is refused.
  it('keeps a chain head whose captured card sits on a bank-capable intent under a card-only policy', async () => {
    mockCreateRecurringCardSetupIntent
      .mockResolvedValueOnce({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method' });
    liveById.set('seti_old', { id: 'seti_old', status: 'succeeded', payment_method: 'pm_old', payment_method_types: ['card'], metadata: { retired: 'true', replaced_by: 'seti_card' } });
    liveById.set('seti_card', { id: 'seti_card', client_secret: 'cs_card', status: 'succeeded', payment_method: { id: 'pm_c', type: 'card' }, payment_method_types: ['card', 'us_bank_account'], metadata: {} });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual(expect.objectContaining({ clientSecret: 'cs_card', setupIntentId: 'seti_card', capturedMethodType: 'card' }));
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledTimes(1);
  });

  it('walks the generation salt when a retired replay\'s chain is broken or ends canceled', async () => {
    mockCreateRecurringCardSetupIntent
      .mockResolvedValueOnce({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method' })
      .mockResolvedValueOnce({ id: 'seti_2', client_secret: 'cs_2', status: 'requires_payment_method' });
    liveById.set('seti_old', { id: 'seti_old', status: 'succeeded', payment_method: 'pm_old', metadata: { retired: 'true' } });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_2', setupIntentId: 'seti_2', paymentMethodTypes: ['card'], capturedMethodType: null });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenNthCalledWith(2, { estimateId: 'est-1', generation: 1, paymentMethodType: 'card' });
    jest.clearAllMocks();
    mockCreateRecurringCardSetupIntent
      .mockResolvedValueOnce({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method' })
      .mockResolvedValueOnce({ id: 'seti_2', client_secret: 'cs_2', status: 'requires_payment_method' });
    liveById.set('seti_old', { id: 'seti_old', status: 'succeeded', payment_method: 'pm_old', metadata: { retired: 'true', replaced_by: 'seti_gone' } });
    liveById.set('seti_gone', { id: 'seti_gone', status: 'canceled', metadata: {} });
    expect((await createRecurringCardSetupIntentForEstimate(EST)).setupIntentId).toBe('seti_2');
  });

  // GATE_ACCEPT_ACH_CAPTURE (owner ruling 2026-09-01): bank joins the accept
  // capture only while the gate is on and the customer has no unhealthy ACH
  // state — the tender the enrollment would refuse must never be offered.
  describe('GATE_ACCEPT_ACH_CAPTURE tender resolution', () => {
    const gates = require('../config/feature-gates').gates;
    beforeEach(() => {
      gates.acceptAchCapture = true;
      mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'requires_payment_method' });
    });
    afterEach(() => { gates.acceptAchCapture = false; });

    it('mints card_or_bank for a new signup with no customer row', async () => {
      expect(await createRecurringCardSetupIntentForEstimate({ id: 'est-1', customer_id: null }))
        .toEqual({ clientSecret: 'cs_1', setupIntentId: 'seti_1', paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: null });
      expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledWith({ estimateId: 'est-1', generation: 0, paymentMethodType: 'card_or_bank' });
    });

    it('mints card_or_bank for an existing customer whose ach_status is healthy (null or active)', async () => {
      mockDbFixtures.customers = { ach_status: null };
      await createRecurringCardSetupIntentForEstimate(EST);
      expect(mockCreateRecurringCardSetupIntent).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethodType: 'card_or_bank' }));
      mockDbFixtures.customers = { ach_status: 'active' };
      await createRecurringCardSetupIntentForEstimate(EST);
      expect(mockCreateRecurringCardSetupIntent).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethodType: 'card_or_bank' }));
    });

    it('falls back to card-only when the customer ACH state is unhealthy (enrollment would refuse ach_blocked)', async () => {
      for (const status of ['needs_verification', 'suspended']) {
        mockDbFixtures.customers = { ach_status: status };
        expect((await createRecurringCardSetupIntentForEstimate(EST)).paymentMethodTypes).toEqual(['card']);
        expect(mockCreateRecurringCardSetupIntent).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethodType: 'card' }));
      }
    });

    it('fails toward card when the ach_status lookup throws', async () => {
      mockDbFixtures.customers = () => { throw new Error('db down'); };
      expect((await createRecurringCardSetupIntentForEstimate(EST)).paymentMethodTypes).toEqual(['card']);
    });

    // Unlinked estimates are judged on the customer the accept will LAND on
    // (pre-push Codex P1): the phone match that the accept transaction runs.
    describe('unlinked estimate (customer_phone only)', () => {
      const UNLINKED = { id: 'est-1', customer_id: null, customer_phone: '9415551234' };

      it('mints card-only when the phone matches an existing customer with an unhealthy bank', async () => {
        mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: { id: 'cust-existing' } });
        mockDbFixtures.customers = { ach_status: 'suspended' };
        expect((await createRecurringCardSetupIntentForEstimate(UNLINKED)).paymentMethodTypes).toEqual(['card']);
      });

      it('mints card_or_bank when the phone matches a healthy existing customer', async () => {
        mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: { id: 'cust-existing' } });
        mockDbFixtures.customers = { ach_status: 'active' };
        expect((await createRecurringCardSetupIntentForEstimate(UNLINKED)).paymentMethodTypes).toEqual(['card', 'us_bank_account']);
      });

      it('mints card_or_bank for a genuinely new customer (no match)', async () => {
        mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: null });
        expect((await createRecurringCardSetupIntentForEstimate(UNLINKED)).paymentMethodTypes).toEqual(['card', 'us_bank_account']);
      });

      it('fails toward card when the grouped-sibling owner lookup errors (Codex #3723 r2 P1)', async () => {
        mockDbFixtures.estimates = () => { throw new Error('sibling lookup down'); };
        mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: null });
        expect((await createRecurringCardSetupIntentForEstimate({ ...UNLINKED, estimate_group_id: 'grp-1' })).paymentMethodTypes).toEqual(['card']);
      });

      it('fails toward card when the phone match itself errors', async () => {
        mockMatchAcceptCustomerByPhone.mockRejectedValue(new Error('lookup down'));
        expect((await createRecurringCardSetupIntentForEstimate(UNLINKED)).paymentMethodTypes).toEqual(['card']);
      });

      it('re-judges the same match at accept-time verification', async () => {
        mockMatchAcceptCustomerByPhone.mockResolvedValue({ match: { id: 'cust-existing' } });
        mockDbFixtures.customers = { ach_status: 'needs_verification' };
        mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, payment_method_types: ['card', 'us_bank_account'], payment_method: { id: 'pm_b', type: 'us_bank_account' } });
        expect((await verifyRecurringCardIntent({ estimate: UNLINKED, setupIntentId: 'seti_1' })).reason).toBe('bank_not_allowed');
      });
    });

    it('stays card-only with the gate off regardless of customer state', async () => {
      gates.acceptAchCapture = false;
      mockDbFixtures.customers = { ach_status: 'active' };
      expect((await createRecurringCardSetupIntentForEstimate(EST)).paymentMethodTypes).toEqual(['card']);
      expect(mockCreateRecurringCardSetupIntent).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethodType: 'card' }));
    });
  });

  it('gives up (null) when every generation replays terminal', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_dead', client_secret: 'cs_dead', status: 'canceled' });
    expect(await createRecurringCardSetupIntentForEstimate(EST)).toBeNull();
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledTimes(5);
  });

  it('passes a succeeded replay straight through (modal short-circuits to onSuccess)', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'succeeded' });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_1', setupIntentId: 'seti_1', paymentMethodTypes: ['card'], capturedMethodType: null });
  });

  it('a succeeded replay resolves the tender already on the intent so the UI renders the matching consent (Codex #3723 r1 P1)', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'succeeded', payment_method: 'pm_b' });
    mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_b', type: 'us_bank_account' });
    expect((await createRecurringCardSetupIntentForEstimate(EST)).capturedMethodType).toBe('us_bank_account');
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'succeeded', payment_method: { id: 'pm_c', type: 'card' } });
    expect((await createRecurringCardSetupIntentForEstimate(EST)).capturedMethodType).toBe('card');
    // A lookup failure leaves it null — the client then fails closed on a
    // bank-capable replay instead of assuming card.
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1', status: 'succeeded', payment_method: 'pm_x' });
    mockRetrievePaymentMethod.mockRejectedValue(new Error('stripe down'));
    expect((await createRecurringCardSetupIntentForEstimate(EST)).capturedMethodType).toBeNull();
  });
});

describe('completeRecurringCardEnrollment (save → consent → enroll)', () => {
  const ARGS = {
    customerId: 'cust-1',
    stripePaymentMethodId: 'pm_1',
    setupIntentId: 'seti_1',
    estimateId: 'est-1',
    ip: '1.2.3.4',
    userAgent: 'jest',
  };

  it('no-ops without a customer or pm', async () => {
    expect((await completeRecurringCardEnrollment({ ...ARGS, customerId: null })).enrolled).toBe(false);
    expect((await completeRecurringCardEnrollment({ ...ARGS, stripePaymentMethodId: null })).enrolled).toBe(false);
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  it('threads the visit scope into the enrollment payer check (GH #3395 r13: self_pay_override visits still enroll)', async () => {
    mockDbFixtures.payment_methods = null;
    mockSavePaymentMethod.mockResolvedValue({ id: 'pmrow-1', method_type: 'card' });
    const r = await completeRecurringCardEnrollment({ ...ARGS, scheduledServiceId: 'ss-42' });
    expect(r.enrolled).toBe(true);
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
      scheduledServiceId: 'ss-42',
    }));
  });

  it('refuses a pm owned by another customer and parks an office exception', async () => {
    mockDbFixtures.payment_methods = { id: 'pmrow-9', customer_id: 'SOMEONE-ELSE' };
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r).toEqual({ enrolled: false, reason: 'pm_ownership_mismatch' });
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalled();
  });

  it('saves, records the estimate_accept consent, links, and enrolls a fresh card', async () => {
    mockDbFixtures.payment_methods = null;
    mockSavePaymentMethod.mockResolvedValue({ id: 'pmrow-1', method_type: 'card' });
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r).toEqual({ enrolled: true, paymentMethodRowId: 'pmrow-1' });
    expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_1', { enableAutopay: false, makeDefault: false });
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      stripePaymentMethodId: 'pm_1',
      source: 'estimate_accept',
      methodType: 'card',
      ip: '1.2.3.4',
      userAgent: 'jest',
    }));
    expect(mockLinkPaymentMethodId).toHaveBeenCalledWith('pm_1', 'pmrow-1');
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      paymentMethodId: 'pmrow-1',
      source: 'estimate_accept',
    }));
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('threads the prepay consent variant into the recorded snapshot (in-lane prepay accepts)', async () => {
    mockDbFixtures.payment_methods = null;
    mockSavePaymentMethod.mockResolvedValue({ id: 'pmrow-1', method_type: 'card' });
    const r = await completeRecurringCardEnrollment({ ...ARGS, consentVariant: 'prepay_card' });
    expect(r.enrolled).toBe(true);
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({ consentVariant: 'prepay_card' }));
  });

  it('threads the after_visit_card consent variant (v12) into the recorded snapshot (PR-B existing customers)', async () => {
    mockDbFixtures.payment_methods = null;
    mockSavePaymentMethod.mockResolvedValue({ id: 'pmrow-1', method_type: 'card' });
    const r = await completeRecurringCardEnrollment({ ...ARGS, consentVariant: 'after_visit_card' });
    expect(r.enrolled).toBe(true);
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({ consentVariant: 'after_visit_card' }));
    // The variant, not the base text, is also the idempotency key.
    expect(mockHasConsentSnapshotForVariant).toHaveBeenCalledWith('cust-1', 'pm_1', expect.objectContaining({ variant: 'after_visit_card' }));
  });

  it('skipEnrollment (PR-B explicit Auto Pay opt-out): saves the card + records consent but NEVER enrolls', async () => {
    mockDbFixtures.payment_methods = null;
    mockSavePaymentMethod.mockResolvedValue({ id: 'pmrow-1', method_type: 'card' });
    const r = await completeRecurringCardEnrollment({ ...ARGS, skipEnrollment: true });
    expect(r).toEqual({ enrolled: false, reason: 'autopay_opt_out_kept', paymentMethodRowId: 'pmrow-1' });
    expect(mockSavePaymentMethod).toHaveBeenCalled();
    expect(mockRecordConsent).toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('is idempotent: reuses an existing pm row and skips a duplicate consent', async () => {
    mockDbFixtures.payment_methods = { id: 'pmrow-1', customer_id: 'cust-1', method_type: 'card' };
    mockHasEnrollmentScopedConsent.mockResolvedValue(true);
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r.enrolled).toBe(true);
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).toHaveBeenCalled();
  });

  it('a hold-only consent does NOT suppress the estimate_accept consent record (Codex r6 P1)', async () => {
    // Version check would pass (a v8 hold row exists) but the enrollment-
    // scoped check refuses it — the estimate_accept audit artifact must be
    // written before Auto Pay enrollment.
    mockHasConsentFor.mockResolvedValue(true);
    mockHasEnrollmentScopedConsent.mockResolvedValue(false);
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r.enrolled).toBe(true);
    expect(mockRecordConsent).toHaveBeenCalledTimes(1);
    expect(mockRecordConsent.mock.calls[0][0]).toMatchObject({ source: 'estimate_accept' });
  });

  it('treats already_enrolled as success (webhook/consent race)', async () => {
    mockDbFixtures.payment_methods = { id: 'pmrow-1', customer_id: 'cust-1' };
    mockEnrollConsentedMethod.mockResolvedValue({ enrolled: false, reason: 'already_enrolled' });
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r.enrolled).toBe(true);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('parks an office exception when enrollment is refused', async () => {
    mockDbFixtures.payment_methods = { id: 'pmrow-1', customer_id: 'cust-1' };
    mockEnrollConsentedMethod.mockResolvedValue({ enrolled: false, reason: 'ach_blocked' });
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r).toEqual({ enrolled: false, reason: 'ach_blocked' });
    expect(mockNotifyAdmin).toHaveBeenCalled();
  });

  it('never throws into the accept flow — a hard failure alerts instead', async () => {
    mockDbFixtures.payment_methods = null;
    mockSavePaymentMethod.mockRejectedValue(new Error('stripe attach failed'));
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r.enrolled).toBe(false);
    expect(mockNotifyAdmin).toHaveBeenCalled();
  });
});
