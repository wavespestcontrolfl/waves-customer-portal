/**
 * Portal ACH Auto Pay — server contracts (GATE_PORTAL_ACH_AUTOPAY lane).
 *
 *  - Consent v10: the ACH variant's revocation contact moved to billing@
 *    (matching the v9 card text) and still qualifies for enrollment.
 *  - POST /cards/setup-intent: gate OFF downgrades bank-inclusive requests
 *    to card-only (the server is authoritative — this closes the leak
 *    where the portal minted card_or_bank while showing CARD consent
 *    copy); gate ON passes card_or_bank through with the
 *    portal_add_method purpose and echoes the effective types.
 *  - POST /cards: a verify_with_microdeposits SetupIntent saves the bank
 *    account PENDING (never default), records the ACH consent with the
 *    portal_add_bank source, and does NOT enroll — enrollment belongs to
 *    the verification webhook.
 *  - PUT /api/billing/autopay: a pending-verification bank row can't be
 *    put in charge of Auto Pay.
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/payment-router', () => ({}));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test_mock', secretKey: null }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendAutopayEnabled: jest.fn(async () => {}),
  sendPaymentMethodUpdated: jest.fn(async () => {}),
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}), getRecent: jest.fn(async () => []) }));
jest.mock('../services/autopay-eligibility', () => ({
  isChargeableAutopayMethod: jest.fn(() => true),
  isBankMethodType: (t) => ['ach', 'us_bank_account'].includes(String(t || '').toLowerCase()),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn(), isCardMethodType: jest.fn((t) => t === 'card') }));
jest.mock('../services/card-enrollment-email', () => ({ sendAutopayEnrollmentConfirmation: jest.fn(async () => null) }));

const mockCreateSetupIntent = jest.fn();
const mockRetrieveSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
jest.mock('../services/stripe', () => ({
  createSetupIntent: (...a) => mockCreateSetupIntent(...a),
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
}));

const mockIsEnabled = jest.fn(() => false);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockIsEnabled(...a), gates: {} }));

const mockRecordConsent = jest.fn(async () => ({ id: 'consent-1' }));
const mockHasConsentFor = jest.fn(async () => false);
jest.mock('../services/payment-method-consents', () => ({
  recordConsent: (...a) => mockRecordConsent(...a),
  hasConsentFor: (...a) => mockHasConsentFor(...a),
  hasEnrollmentScopedConsent: jest.fn(async () => true),
  linkPaymentMethodId: jest.fn(async () => {}),
}));

const mockEnroll = jest.fn(async () => ({ enrolled: true, methodId: 'pm-row-1', inChargeMethodId: 'pm-row-1' }));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: (...a) => mockEnroll(...a) }));

const state = { tables: {}, updates: [] };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const rows = () => state.tables[table] || [];
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    q.whereNotNull = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.first = jest.fn(async () => rows()[0] || null);
    q.update = jest.fn(async (patch) => { state.updates.push({ table, patch }); return 1; });
    q.then = (ok, bad) => Promise.resolve(rows()).then(ok, bad);
    return q;
  });
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(db));
  return db;
});

const billingRouter = require('../routes/billing-v2');
const autopayRouter = require('../routes/customer-autopay');
const { CONSENT_VERSION, ACH_CONSENT_TEXT, CARD_CONSENT_TEXT } = require('../services/payment-method-consent-text');
const { consentVersionQualifiesForEnrollment } = jest.requireActual('../services/payment-method-consents');

function routeHandler(router, method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, { body = {}, params = {}, customerId = 'cust-1' } = {}) {
  const req = { customerId, body, params, ip: '1.2.3.4', get: () => 'jest-agent' };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; return this; },
  };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { statusCode, body: jsonBody };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(false);
  mockHasConsentFor.mockResolvedValue(false);
  state.tables = {};
  state.updates = [];
});

describe('consent v10 (ACH revocation contact aligned to billing@)', () => {
  test('version bumped and ACH text names billing@, not contact@', () => {
    expect(CONSENT_VERSION).toBe('v10_2026-07-13');
    expect(ACH_CONSENT_TEXT).toContain('billing@wavespestcontrol.com');
    expect(ACH_CONSENT_TEXT).not.toContain('contact@wavespestcontrol.com');
    // Card text unchanged by the bump.
    expect(CARD_CONSENT_TEXT).toContain('billing@wavespestcontrol.com');
  });

  test('v10 still qualifies for enrollment (≥v8 gate)', () => {
    expect(consentVersionQualifiesForEnrollment('v10_2026-07-13')).toBe(true);
  });
});

describe('POST /cards/setup-intent — gate-authoritative method types', () => {
  const handler = () => routeHandler(billingRouter, 'post', '/cards/setup-intent');

  test('gate OFF: card_or_bank downgrades to card-only', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockCreateSetupIntent.mockResolvedValue({ clientSecret: 'cs', setupIntentId: 'si_1', paymentMethodTypes: ['card'] });
    const { body } = await invoke(handler(), { body: { paymentMethodType: 'card_or_bank' } });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith('cust-1', 'card', expect.objectContaining({
      metadata: { purpose: 'portal_add_method' },
    }));
    expect(body.paymentMethodTypes).toEqual(['card']);
  });

  test('gate ON: card_or_bank passes through with the portal_add_method purpose', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockCreateSetupIntent.mockResolvedValue({ clientSecret: 'cs', setupIntentId: 'si_1', paymentMethodTypes: ['card', 'us_bank_account'] });
    const { body } = await invoke(handler(), { body: { paymentMethodType: 'card_or_bank' } });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith('cust-1', 'card_or_bank', expect.objectContaining({
      metadata: { purpose: 'portal_add_method' },
    }));
    expect(body.paymentMethodTypes).toEqual(['card', 'us_bank_account']);
  });
});

describe('POST /cards — micro-deposit deferred bank save', () => {
  const handler = () => routeHandler(billingRouter, 'post', '/cards');
  const pendingSetupIntent = {
    id: 'si_md',
    status: 'requires_action',
    next_action: { type: 'verify_with_microdeposits' },
    payment_method: 'pm_bank_1',
  };
  const pendingRow = {
    id: 'pm-row-1',
    customer_id: 'cust-1',
    method_type: 'ach',
    bank_name: 'Chase Bank',
    bank_last_four: '6789',
    last_four: '6789',
    is_default: false,
    ach_status: 'pending_verification',
  };

  test('gate ON: saves PENDING (never default), records portal_add_bank consent, does NOT enroll', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockRetrieveSetupIntent.mockResolvedValue(pendingSetupIntent);
    mockSavePaymentMethod.mockResolvedValue(pendingRow);
    const { statusCode, body } = await invoke(handler(), { body: { setupIntentId: 'si_md' } });
    expect(statusCode).toBe(200);
    expect(body.pendingVerification).toBe(true);
    expect(body.card.achStatus).toBe('pending_verification');
    expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_bank_1', {
      enableAutopay: false,
      makeDefault: false,
      achStatus: 'pending_verification',
      // Atomic with the insert (Codex r5) — no crash window between the
      // pending row and its removal-tombstone handle.
      setupIntentId: 'si_md',
    });
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'portal_add_bank',
      methodType: 'ach',
      stripePaymentMethodId: 'pm_bank_1',
    }));
    // Enrollment belongs to the verification webhook — an unverified bank
    // account must never be put in charge of Auto Pay.
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('retry does not duplicate the consent row (hasConsentFor guard)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockRetrieveSetupIntent.mockResolvedValue(pendingSetupIntent);
    state.tables.payment_methods = [pendingRow];
    mockHasConsentFor.mockResolvedValue(true);
    const { body } = await invoke(handler(), { body: { setupIntentId: 'si_md' } });
    expect(body.pendingVerification).toBe(true);
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
  });

  test('gate OFF: micro-deposit SetupIntent falls to the strict 409 (state unreachable via our client)', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockRetrieveSetupIntent.mockResolvedValue(pendingSetupIntent);
    const { statusCode } = await invoke(handler(), { body: { setupIntentId: 'si_md' } });
    expect(statusCode).toBe(409);
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
  });

  test('returned from hosted verification: succeeded SI marks the pending row VERIFIED and clears needs_verification before enrolling (Codex r2+r3)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_md',
      status: 'succeeded',
      payment_method: 'pm_bank_1',
    });
    state.tables.payment_methods = [pendingRow];
    const { statusCode } = await invoke(handler(), { body: { setupIntentId: 'si_md' } });
    expect(statusCode).toBe(200);
    // The customer beat the webhook back to the portal — without this the
    // enrollment runs against a row the autopay routes still refuse, and
    // without the customer-level clear enrollConsentedMethod still 409s.
    expect(state.updates).toContainEqual({ table: 'payment_methods', patch: { ach_status: 'verified' } });
    expect(state.updates).toContainEqual({ table: 'customers', patch: { ach_status: 'active' } });
    expect(mockEnroll).toHaveBeenCalled();
  });

  test('FC-instant save (row already verified) STILL clears the customer needs_verification block (Codex r6)', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_fc',
      status: 'succeeded',
      payment_method: 'pm_bank_1',
    });
    // Financial Connections verifies instantly — the row never passes
    // through pending, so a pending-only conditional left the customer
    // block set and enrollment 409'd the add the customer just completed.
    state.tables.payment_methods = [{ ...pendingRow, ach_status: 'verified' }];
    const { statusCode } = await invoke(handler(), { body: { setupIntentId: 'si_fc' } });
    expect(statusCode).toBe(200);
    expect(state.updates).toContainEqual({ table: 'customers', patch: { ach_status: 'active' } });
    // No pm-row rewrite needed — it was already verified.
    expect(state.updates.filter((u) => u.table === 'payment_methods')).toHaveLength(0);
    expect(mockEnroll).toHaveBeenCalled();
  });

  test('gate OFF: an in-flight SUCCEEDED bank SetupIntent is refused before any mirror (kill-switch integrity, Codex r3)', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_late',
      status: 'succeeded',
      payment_method: { id: 'pm_bank_1', type: 'us_bank_account' },
    });
    const { statusCode } = await invoke(handler(), { body: { setupIntentId: 'si_late' } });
    expect(statusCode).toBe(409);
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('ownership mismatch on the pending row → 409, nothing recorded', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockRetrieveSetupIntent.mockResolvedValue(pendingSetupIntent);
    state.tables.payment_methods = [{ ...pendingRow, customer_id: 'cust-OTHER' }];
    const { statusCode } = await invoke(handler(), { body: { setupIntentId: 'si_md' } });
    expect(statusCode).toBe(409);
    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(mockEnroll).not.toHaveBeenCalled();
  });
});

describe('PUT /api/billing/autopay — pending bank cannot take charge', () => {
  const handler = () => routeHandler(autopayRouter, 'put', '/');

  test('selecting a pending-verification bank row for Auto Pay → 400', async () => {
    state.tables.customers = [{ autopay_enabled: false, autopay_payment_method_id: null, billing_day: 1 }];
    state.tables.payment_methods = [{
      id: 'pm-bank',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'ach',
      ach_status: 'pending_verification',
    }];
    const { statusCode, body } = await invoke(handler(), {
      body: { autopay_enabled: true, autopay_payment_method_id: 'pm-bank' },
    });
    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/still being verified/i);
  });

  test('set-default refuses a pending bank — the route carries Auto Pay onto the new default', async () => {
    state.tables.payment_methods = [{
      id: 'pm-bank',
      customer_id: 'cust-1',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'ach',
      ach_status: 'pending_verification',
      is_default: false,
      autopay_enabled: false,
    }];
    const setDefault = routeHandler(billingRouter, 'put', '/cards/:id/default');
    const { statusCode, body } = await invoke(setDefault, { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/still being verified/i);
  });

  test('a verified bank row is selectable', async () => {
    state.tables.customers = [{ autopay_enabled: false, autopay_payment_method_id: null, billing_day: 1 }];
    state.tables.payment_methods = [{
      id: 'pm-bank',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'ach',
      ach_status: 'verified',
    }];
    const { statusCode, body } = await invoke(handler(), {
      body: { autopay_enabled: true, autopay_payment_method_id: 'pm-bank' },
    });
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
  });

  test('a VERIFIED bank is still refused while the customer-level ACH block is non-active (Codex r3)', async () => {
    state.tables.customers = [{ autopay_enabled: false, autopay_payment_method_id: null, billing_day: 1, ach_status: 'suspended' }];
    state.tables.payment_methods = [{
      id: 'pm-bank',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'ach',
      ach_status: 'verified',
    }];
    const { statusCode, body } = await invoke(handler(), {
      body: { autopay_enabled: true, autopay_payment_method_id: 'pm-bank' },
    });
    // customerOnAutopay/cron would treat these flags as inactive — reject
    // honestly instead of silently stopping collection.
    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/unavailable on your account/i);
  });

  test("the 'us_bank_account' ALIAS hits the same guards — alias rows must not slip past (Codex r5)", async () => {
    state.tables.customers = [{ autopay_enabled: false, autopay_payment_method_id: null, billing_day: 1, ach_status: 'suspended' }];
    state.tables.payment_methods = [{
      id: 'pm-bank',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'us_bank_account',
      ach_status: 'verified',
    }];
    const { statusCode, body } = await invoke(handler(), {
      body: { autopay_enabled: true, autopay_payment_method_id: 'pm-bank' },
    });
    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/unavailable on your account/i);
  });

  test('a verification_failed bank row is refused with the remove-and-re-add message (Codex r3)', async () => {
    state.tables.customers = [{ autopay_enabled: false, autopay_payment_method_id: null, billing_day: 1 }];
    state.tables.payment_methods = [{
      id: 'pm-bank',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'ach',
      ach_status: 'verification_failed',
    }];
    const { statusCode, body } = await invoke(handler(), {
      body: { autopay_enabled: true, autopay_payment_method_id: 'pm-bank' },
    });
    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/could not be verified/i);
  });
});

describe('PUT /cards/:id/default — customer-level ACH block (Codex r3)', () => {
  test('set-default on a VERIFIED bank is refused while the customer ACH block is non-active', async () => {
    state.tables.payment_methods = [{
      id: 'pm-bank',
      customer_id: 'cust-1',
      processor: 'stripe',
      stripe_payment_method_id: 'pm_bank_1',
      method_type: 'ach',
      ach_status: 'verified',
      is_default: false,
      autopay_enabled: false,
    }];
    state.tables.customers = [{ ach_status: 'suspended' }];
    const setDefault = routeHandler(billingRouter, 'put', '/cards/:id/default');
    const { statusCode, body } = await invoke(setDefault, { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/unavailable on your account/i);
  });
});

describe('GET /cards/:id/bank-verification-link — durable resume (Codex r3)', () => {
  const handler = () => routeHandler(billingRouter, 'get', '/cards/:id/bank-verification-link');
  const pendingBankRow = {
    id: 'pm-bank',
    customer_id: 'cust-1',
    method_type: 'ach',
    ach_status: 'pending_verification',
    stripe_setup_intent_id: 'si_md',
  };

  test('gate OFF → 404', async () => {
    mockIsEnabled.mockReturnValue(false);
    state.tables.payment_methods = [pendingBankRow];
    const { statusCode } = await invoke(handler(), { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(404);
  });

  test('SI still awaiting deposits → returns the hosted verification url', async () => {
    mockIsEnabled.mockReturnValue(true);
    state.tables.payment_methods = [pendingBankRow];
    mockRetrieveSetupIntent.mockResolvedValue({
      id: 'si_md',
      status: 'requires_action',
      next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: 'https://verify.stripe.com/x' } },
    });
    const { statusCode, body } = await invoke(handler(), { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(200);
    expect(body.url).toBe('https://verify.stripe.com/x');
  });

  test('SI already succeeded → heals the stale pending row AND finishes the consent-gated enrollment (Codex r3+r4)', async () => {
    mockIsEnabled.mockReturnValue(true);
    state.tables.payment_methods = [{ ...pendingBankRow, stripe_payment_method_id: 'pm_bank_1' }];
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'si_md', status: 'succeeded' });
    const { statusCode, body } = await invoke(handler(), { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(200);
    expect(body.verified).toBe(true);
    expect(state.updates).toContainEqual({ table: 'payment_methods', patch: { ach_status: 'verified' } });
    expect(state.updates).toContainEqual({ table: 'customers', patch: { ach_status: 'active' } });
    // The deferred save recorded the Auto Pay consent but never enrolled —
    // with the webhook missed, this heal is the last chance to honor it.
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'pm-bank', source: 'portal_add_bank' }));
    expect(body.enrolled).toBe(true);
  });

  test('SI dead (canceled/failed) → row moves to verification_failed instead of pending forever', async () => {
    mockIsEnabled.mockReturnValue(true);
    state.tables.payment_methods = [pendingBankRow];
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'si_md', status: 'canceled' });
    const { statusCode, body } = await invoke(handler(), { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(200);
    expect(body.failed).toBe(true);
    expect(state.updates).toContainEqual({ table: 'payment_methods', patch: { ach_status: 'verification_failed' } });
  });

  test('no persisted SetupIntent id → 404', async () => {
    mockIsEnabled.mockReturnValue(true);
    state.tables.payment_methods = [{ ...pendingBankRow, stripe_setup_intent_id: null }];
    const { statusCode } = await invoke(handler(), { params: { id: 'pm-bank' } });
    expect(statusCode).toBe(404);
  });
});
