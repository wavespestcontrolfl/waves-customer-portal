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
    for (const m of ['where', 'whereNot', 'whereNotNull', 'whereNull', 'orderBy']) c[m] = () => c;
    return c;
  };
  const mock = jest.fn((table) => chain(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockRetrieveSetupIntent = jest.fn();
const mockCreateRecurringCardSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
const mockRetrievePaymentMethod = jest.fn();
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  createRecurringCardSetupIntent: (...a) => mockCreateRecurringCardSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
  retrievePaymentMethod: (...a) => mockRetrievePaymentMethod(...a),
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
  bankTenderAllowedUnderLock,
  completeRecurringCardEnrollment,
  _private: { recurringCardIntentMatchesEstimate },
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
afterAll(() => { delete process.env.RECURRING_CARD_ON_FILE; });

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

describe('createRecurringCardSetupIntentForEstimate', () => {
  it('returns null when Stripe is not configured', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue(null);
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
