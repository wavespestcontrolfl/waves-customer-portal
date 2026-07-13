/**
 * setup_intent.succeeded → portal_add_method branch (portal ACH lane).
 *
 * For the micro-deposit deferred save this webhook is the ONLY completion
 * path: the customer's session ended days before verification cleared.
 * Contract:
 *  - a pending bank row flips ach_status → 'verified';
 *  - enrollment happens ONLY behind hasEnrollmentScopedConsent (the
 *    consent row is the authority — never SI metadata alone, Codex #2507);
 *  - ownership mismatches skip everything;
 *  - re-delivery for an already-completed card save no-ops into
 *    already_enrolled (idempotent).
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({ classifyExistingWebhookEvent: jest.fn(), STALE_CLAIM_WINDOW_MS: 60000 }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/stripe-invoice-state', () => ({
  isInvoiceCollectibleStatus: jest.fn(() => true),
  invoiceStatusForSuccessfulPayment: jest.fn(),
  invoiceStatusForFailedPayment: jest.fn(),
  INVOICE_COLLECTIBLE_STATUSES: [],
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
const mockGateEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockGateEnabled(...a), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));

const mockSavePaymentMethod = jest.fn();
const mockRetrievePaymentMethod = jest.fn(async () => ({ id: 'pm_bank_1', type: 'us_bank_account' }));
jest.mock('../services/stripe', () => ({
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
  retrievePaymentMethod: (...a) => mockRetrievePaymentMethod(...a),
}));

const mockRecordConsent = jest.fn(async () => ({ id: 'consent-1' }));
const mockHasConsentFor = jest.fn(async () => true);
const mockHasEnrollmentScopedConsent = jest.fn(async () => true);
const mockLinkPaymentMethodId = jest.fn(async () => {});
jest.mock('../services/payment-method-consents', () => ({
  recordConsent: (...a) => mockRecordConsent(...a),
  hasConsentFor: (...a) => mockHasConsentFor(...a),
  hasEnrollmentScopedConsent: (...a) => mockHasEnrollmentScopedConsent(...a),
  linkPaymentMethodId: (...a) => mockLinkPaymentMethodId(...a),
}));

const mockEnroll = jest.fn(async () => ({ enrolled: true, methodId: 'pm-row-1', inChargeMethodId: 'pm-row-1' }));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: (...a) => mockEnroll(...a) }));

const state = { paymentMethodRow: null, updates: [] };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = { _wheres: [] };
    q.where = jest.fn((...a) => { q._wheres.push(a[0]); return q; });
    q.first = jest.fn(async () => (table === 'payment_methods' ? state.paymentMethodRow : null));
    q.update = jest.fn(async (patch) => { state.updates.push({ table, wheres: q._wheres, patch }); return 1; });
    return q;
  });
  db.transaction = jest.fn();
  return db;
});
const updatesFor = (table) => state.updates.filter((u) => u.table === table);

const {
  _handleSetupIntentSucceeded: handleSetupIntentSucceeded,
  _handleSetupIntentFailed: handleSetupIntentFailed,
} = require('../routes/stripe-webhook');

const setupIntent = (over = {}) => ({
  id: 'si_1',
  status: 'succeeded',
  payment_method: 'pm_bank_1',
  metadata: { purpose: 'portal_add_method', waves_customer_id: 'cust-1' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGateEnabled.mockReturnValue(true);
  mockHasConsentFor.mockResolvedValue(true);
  mockHasEnrollmentScopedConsent.mockResolvedValue(true);
  mockEnroll.mockResolvedValue({ enrolled: true, methodId: 'pm-row-1', inChargeMethodId: 'pm-row-1' });
  state.updates = [];
  state.paymentMethodRow = {
    id: 'pm-row-1',
    customer_id: 'cust-1',
    method_type: 'ach',
    ach_status: 'pending_verification',
  };
});

test('pending bank verifies: ach_status → verified, consent-gated enrollment fires with the bank source', async () => {
  await handleSetupIntentSucceeded(setupIntent());
  expect(updatesFor('payment_methods').map((u) => u.patch)).toContainEqual({ ach_status: 'verified' });
  expect(mockLinkPaymentMethodId).toHaveBeenCalledWith('pm_bank_1', 'pm-row-1');
  expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
    customerId: 'cust-1',
    paymentMethodId: 'pm-row-1',
    source: 'portal_add_bank',
  }));
  // Enrollment-scoped consent already recorded by the deferred save — no
  // duplicate row.
  expect(mockRecordConsent).not.toHaveBeenCalled();
});

test('bank verification clears a customer-level needs_verification block ONLY (Codex r2)', async () => {
  await handleSetupIntentSucceeded(setupIntent());
  const customerUpdates = updatesFor('customers');
  expect(customerUpdates).toHaveLength(1);
  expect(customerUpdates[0].patch).toEqual({ ach_status: 'active' });
  // Scoped to needs_verification — a suspended customer (repeated failed
  // debits) is NOT silently unblocked by adding a new account; that state
  // keeps its organic exit (a successful ACH payment).
  expect(customerUpdates[0].wheres).toContainEqual(expect.objectContaining({ ach_status: 'needs_verification' }));
});

test('hold-scoped-only history: the portal consent the customer just granted is recorded, then enrollment proceeds (Codex r2)', async () => {
  // hasConsentFor would be true (a hold row exists) — the old guard
  // suppressed the portal consent and enrollment silently skipped.
  mockHasConsentFor.mockResolvedValue(true);
  mockHasEnrollmentScopedConsent.mockResolvedValue(false);
  await handleSetupIntentSucceeded(setupIntent());
  expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({ source: 'portal_add_bank', methodType: 'ach' }));
  expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ source: 'portal_add_bank' }));
});

test('ownership mismatch skips everything', async () => {
  state.paymentMethodRow = { ...state.paymentMethodRow, customer_id: 'cust-OTHER' };
  await handleSetupIntentSucceeded(setupIntent());
  expect(state.updates).toHaveLength(0);
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
});

test('re-delivery for a completed CARD save is a benign no-op re-run (already_enrolled path)', async () => {
  state.paymentMethodRow = { id: 'pm-row-2', customer_id: 'cust-1', method_type: 'card', ach_status: null };
  mockEnroll.mockResolvedValue({ enrolled: false, reason: 'already_enrolled', methodId: 'pm-row-2' });
  await handleSetupIntentSucceeded(setupIntent({ payment_method: 'pm_card_1' }));
  // No bank verification or customer ACH-state writes for a card row.
  expect(state.updates).toHaveLength(0);
  expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ source: 'portal_add_card' }));
});

test('browser died before POST /cards: webhook saves the method itself (attached-only)', async () => {
  state.paymentMethodRow = null;
  mockSavePaymentMethod.mockImplementation(async () => {
    state.paymentMethodRow = { id: 'pm-row-3', customer_id: 'cust-1', method_type: 'ach', ach_status: 'verified' };
    return state.paymentMethodRow;
  });
  mockHasEnrollmentScopedConsent.mockResolvedValueOnce(false);
  await handleSetupIntentSucceeded(setupIntent());
  expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_bank_1', {
    enableAutopay: false,
    makeDefault: false,
    requireAttached: true,
  });
  expect(mockRecordConsent).toHaveBeenCalled();
});

test('a REMOVED pending method is never resurrected: detached PM skips the backstop quietly (Codex r1)', async () => {
  state.paymentMethodRow = null;
  const detachedErr = new Error('Payment method is not attached to this customer');
  detachedErr.code = 'PM_NOT_ATTACHED';
  mockSavePaymentMethod.mockRejectedValue(detachedErr);
  // Resolves (acks) — a retry can't change a customer's removal.
  await expect(handleSetupIntentSucceeded(setupIntent())).resolves.toBeUndefined();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(state.updates).toHaveLength(0);
});

test('gate off: an in-flight bank completion is skipped — the kill switch closes the whole portal bank lane (Codex r3)', async () => {
  mockGateEnabled.mockReturnValue(false);
  await handleSetupIntentSucceeded(setupIntent());
  expect(state.updates).toHaveLength(0);
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
});

test('gate off + browser died (no local row): PM type probed BEFORE persistence, bank never saved (Codex r4 P1)', async () => {
  mockGateEnabled.mockReturnValue(false);
  state.paymentMethodRow = null;
  mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_bank_1', type: 'us_bank_account' });
  await handleSetupIntentSucceeded(setupIntent());
  // Nothing persisted at all — a saved verified row would be selectable by
  // the billing routes even with the lane closed.
  expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(state.updates).toHaveLength(0);
});

test('gate off + browser died: a CARD completion still proceeds (card lane unaffected by the ACH gate)', async () => {
  mockGateEnabled.mockReturnValue(false);
  state.paymentMethodRow = null;
  mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_card_1', type: 'card' });
  mockSavePaymentMethod.mockImplementation(async () => {
    state.paymentMethodRow = { id: 'pm-row-4', customer_id: 'cust-1', method_type: 'card', ach_status: null };
    return state.paymentMethodRow;
  });
  await handleSetupIntentSucceeded(setupIntent({ payment_method: 'pm_card_1' }));
  expect(mockSavePaymentMethod).toHaveBeenCalled();
  expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ source: 'portal_add_card' }));
});

test('setup_failed moves a pending bank row to verification_failed (Codex r3)', async () => {
  await handleSetupIntentFailed({
    id: 'si_md',
    payment_method: 'pm_bank_1',
    last_setup_error: { message: 'Microdeposit amounts do not match' },
    metadata: { waves_customer_id: 'cust-1' },
  });
  const pmUpdates = updatesFor('payment_methods');
  expect(pmUpdates).toHaveLength(1);
  expect(pmUpdates[0].patch).toEqual({ ach_status: 'verification_failed' });
  // Scoped to PENDING rows only — a stale failure event can never demote a
  // verified account.
  expect(pmUpdates[0].wheres).toContainEqual(expect.objectContaining({ ach_status: 'pending_verification' }));
});
