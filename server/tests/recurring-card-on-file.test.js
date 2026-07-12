// Recurring card-on-file (Auto Pay at accept). Mirrors the estimate-card-holds
// test harness: db + stripe + logger mocked, the policy decision logic
// exercised directly, the trust-boundary verify path checked against Stripe,
// and the post-commit save → consent → enroll sequence pinned so it can't
// drift from the pay page's /setup-complete semantics.

let mockDbFixtures = {};
jest.mock('../models/db', () => {
  const chain = (table) => ({
    where: () => ({
      first: async (...args) => {
        const v = mockDbFixtures[table];
        if (typeof v === 'function') return v(...args);
        return v ?? null;
      },
    }),
  });
  const mock = jest.fn((table) => chain(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockRetrieveSetupIntent = jest.fn();
const mockCreateRecurringCardSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  createRecurringCardSetupIntent: (...a) => mockCreateRecurringCardSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
}));

const mockQualifyingRows = jest.fn(async () => []);
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: (...a) => mockQualifyingRows(...a),
}));
const mockResolveForInvoice = jest.fn(async () => null);
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...a) => mockResolveForInvoice(...a),
}));
const mockCustomerOnAutopay = jest.fn(async () => false);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockCustomerOnAutopay(...a),
}));
const mockHasConsentFor = jest.fn(async () => false);
const mockRecordConsent = jest.fn(async () => ({ id: 'consent1' }));
const mockLinkPaymentMethodId = jest.fn(async () => {});
jest.mock('../services/payment-method-consents', () => ({
  hasConsentFor: (...a) => mockHasConsentFor(...a),
  recordConsent: (...a) => mockRecordConsent(...a),
  linkPaymentMethodId: (...a) => mockLinkPaymentMethodId(...a),
}));
const mockEnrollConsentedMethod = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/autopay-enrollment', () => ({
  enrollConsentedMethod: (...a) => mockEnrollConsentedMethod(...a),
}));
const mockNotifyAdmin = jest.fn(async () => {});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
// The policy's linked-appointment fallback lazy-requires the route module —
// stub it so tests never load the real (heavy) estimate-public.
jest.mock('../routes/estimate-public', () => ({
  findLinkedUpcomingAppointment: jest.fn(async () => null),
}));

const {
  isRecurringCardOnFileEnabled,
  resolveRecurringCardPolicyForEstimate,
  createRecurringCardSetupIntentForEstimate,
  verifyRecurringCardIntent,
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
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-1', scheduledServiceId: 'ss-9' });
  });

  it('keeps the card required when the payer check fails', async () => {
    mockResolveForInvoice.mockRejectedValue(new Error('payer svc down'));
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.required).toBe(true);
  });

  it('exempts a customer already on Auto Pay with a chargeable method', async () => {
    mockDbFixtures.customers = { id: 'cust-1', autopay_enabled: true };
    mockCustomerOnAutopay.mockResolvedValue(true);
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: EST });
    expect(p.exemptReason).toBe('autopay_already_active');
  });

  it('requires the card for a plain new recurring accept (and with no linked customer)', async () => {
    expect((await resolveRecurringCardPolicyForEstimate({ estimate: EST })).required).toBe(true);
    expect((await resolveRecurringCardPolicyForEstimate({ estimate: { id: 'est-2', customer_id: null } })).required).toBe(true);
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
      .toEqual({ ok: true, paymentMethodId: 'pm_1', setupIntentId: 'seti_1' });
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, payment_method: { id: 'pm_9' } });
    expect((await verifyRecurringCardIntent({ estimate: EST, setupIntentId: 'seti_1' })).paymentMethodId).toBe('pm_9');
  });

  it('matcher pins purpose + estimate + status + pm', () => {
    expect(recurringCardIntentMatchesEstimate(GOOD_SI, 'est-1')).toBe(true);
    expect(recurringCardIntentMatchesEstimate(null, 'est-1')).toBe(false);
  });
});

describe('createRecurringCardSetupIntentForEstimate', () => {
  it('returns null when Stripe is not configured', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue(null);
    expect(await createRecurringCardSetupIntentForEstimate(EST)).toBeNull();
  });

  it('returns the client secret for the capture UI', async () => {
    mockCreateRecurringCardSetupIntent.mockResolvedValue({ id: 'seti_1', client_secret: 'cs_1' });
    expect(await createRecurringCardSetupIntentForEstimate(EST))
      .toEqual({ clientSecret: 'cs_1', setupIntentId: 'seti_1' });
    expect(mockCreateRecurringCardSetupIntent).toHaveBeenCalledWith({ estimateId: 'est-1' });
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

  it('is idempotent: reuses an existing pm row and skips a duplicate consent', async () => {
    mockDbFixtures.payment_methods = { id: 'pmrow-1', customer_id: 'cust-1', method_type: 'card' };
    mockHasConsentFor.mockResolvedValue(true);
    const r = await completeRecurringCardEnrollment(ARGS);
    expect(r.enrolled).toBe(true);
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).toHaveBeenCalled();
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
