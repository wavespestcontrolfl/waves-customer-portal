/**
 * handleAchFailure — escalation contract.
 *
 * Pins the fixes from the payments audit:
 *  - an escalation write failure REJECTS (the router records the error and
 *    500s, so the event stays unprocessed and Stripe redelivers) instead
 *    of being swallowed and acked — the failure-count bump is never lost;
 *  - the >=3-failure card fallback is COMPLETE: the card row gets BOTH
 *    is_default and autopay_enabled (non-selected rows get both cleared,
 *    the customer-autopay PUT idiom) and customers.autopay_payment_method_id
 *    is repointed — after the flip getChargeableAutopayMethod returns the
 *    card, so collection keeps working;
 *  - the fallback is CONSENT-SCOPED (Codex #2822 P1): only a card with an
 *    enrollment-qualifying consent row (v8+, non-hold source, no later
 *    Auto Pay opt-out — the REAL findConsentedChargeableCard over the db
 *    mock) is ever promoted; hold-only/legacy-consent cards leave the
 *    account without a fallback, and a consent-lookup error REJECTS
 *    (fail closed, webhook redelivers) instead of reading as "no consent";
 *  - notification-side failures (SMS provider, follow-up engine) stay
 *    non-critical: inner-caught, no rethrow;
 *  - replayed events (ach_failure_log event-id dedupe) skip SMS + follow-up
 *    side effects.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  lateSavedCardPaymentNeedsOrphan: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
}));
const mockRenderTemplate = jest.fn(async () => 'msg');
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: (...a) => mockRenderTemplate(...a),
}));
jest.mock('../services/stripe-invoice-state', () => ({
  assertInvoicePaymentIntentTenderMatches: jest.fn(),
  isAchPaymentIntent: jest.fn(() => true),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentFailed: jest.fn(async () => {}) }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));
const mockHandleAutopayFailure = jest.fn(async () => {});
jest.mock('../services/invoice-followups', () => ({
  handleAutopayFailure: (...a) => mockHandleAutopayFailure(...a),
}));

// Mutable fixtures behind the shared db mock.
const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    paymentRow: { id: 'pay-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_ach_1' },
    invoiceRow: null,
    customer: { id: 'cust-1', first_name: 'Pat', phone: '+15550001111' },
    achLogRow: null,        // existing ach_failure_log row (replay when set)
    recentFailures: 1,
    paymentMethodRows: [],  // live rows — trx updates are APPLIED to these
    consentRows: [],        // payment_method_consents rows (real helper reads these)
    lastAutopayToggle: null, // latest autopay_log enable/disable row
    failConsentLookup: false, // consent-helper db reads throw (fail-closed path)
    customerUpdates: [],
    trxUpdates: [],
    failCustomerUpdate: false,
  });
}

const mockRowMatches = (row, wheres) => wheres.every((w) => (
  w && typeof w === 'object' && !Array.isArray(w)
    ? Object.entries(w).every(([k, v]) => row[k] === v)
    : true
));

function mockMakeTrxBuilder(table) {
  const b = { _wheres: [], _counted: false };
  ['where', 'andWhere', 'whereIn', 'whereNot', 'whereNull', 'whereRaw'].forEach((name) => {
    b[name] = (...args) => {
      if (args.length && typeof args[0] === 'object') b._wheres.push(args[0]);
      return b;
    };
  });
  b.count = () => { b._counted = true; return b; };
  b.columnInfo = async () => ({ stripe_event_id: {} });
  b.first = async () => {
    if (table === 'ach_failure_log') return b._counted ? { cnt: mockState.recentFailures } : mockState.achLogRow;
    if (table === 'payment_methods') {
      return mockState.paymentMethodRows.find((r) => mockRowMatches(r, b._wheres)) || null;
    }
    if (table === 'customers') return mockState.customer;
    return null;
  };
  b.update = async (patch) => {
    mockState.trxUpdates.push({ table, wheres: b._wheres, patch });
    if (table === 'customers') {
      if (mockState.failCustomerUpdate) throw new Error('escalation write failed');
      mockState.customerUpdates.push(patch);
    }
    if (table === 'payment_methods') {
      for (const row of mockState.paymentMethodRows) {
        if (mockRowMatches(row, b._wheres)) Object.assign(row, patch);
      }
    }
    return 1;
  };
  b.insert = async () => [];
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const b = { _wheres: [] };
    // whereNull/whereNotNull/orderBy/select are chain-only; the REAL
    // payment-method-consents helper runs over this mock.
    ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orderBy', 'select'].forEach((name) => {
      b[name] = (...args) => {
        if (args.length && typeof args[0] === 'object' && !Array.isArray(args[0])) b._wheres.push(args[0]);
        return b;
      };
    });
    b.first = async () => {
      if (table === 'autopay_log' && mockState.failConsentLookup) throw new Error('consent lookup failed');
      if (table === 'payments') return mockState.paymentRow;
      if (table === 'invoices') return mockState.invoiceRow;
      if (table === 'customers') return mockState.customer;
      if (table === 'autopay_log') return mockState.lastAutopayToggle;
      return null;
    };
    // Awaiting the bare builder resolves the row LIST — how the real
    // findConsentedChargeableCard / hasEnrollmentScopedConsent read
    // saved cards and their consent rows.
    b.then = (resolve, reject) => (async () => {
      if (mockState.failConsentLookup) throw new Error('consent lookup failed');
      if (table === 'payment_methods') return mockState.paymentMethodRows.filter((r) => mockRowMatches(r, b._wheres));
      if (table === 'payment_method_consents') return mockState.consentRows.filter((r) => mockRowMatches(r, b._wheres));
      return [];
    })().then(resolve, reject);
    b.update = async () => 1;
    return b;
  });
  db.raw = jest.fn(async () => ({ rowCount: 1 }));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => mockMakeTrxBuilder(table));
    trx.raw = jest.fn(async () => {});
    return fn(trx);
  });
  return db;
});

const { _handleAchFailure: handleAchFailure } = require('../routes/stripe-webhook');
// Real predicate — the whole point of the fallback fix is that this
// starts returning the card after the flip.
const { getChargeableAutopayMethod } = jest.requireActual('../services/autopay-eligibility');

const BANK_ROW = () => ({
  id: 'pm-bank',
  customer_id: 'cust-1',
  processor: 'stripe',
  method_type: 'ach',
  is_default: true,
  autopay_enabled: true,
  stripe_payment_method_id: 'pm_bank_stripe',
  exp_month: null,
  exp_year: null,
});
const CARD_ROW = () => ({
  id: 'pm-card',
  customer_id: 'cust-1',
  processor: 'stripe',
  method_type: 'card',
  is_default: false,
  autopay_enabled: false,
  stripe_payment_method_id: 'pm_card_stripe',
  exp_month: 12,
  exp_year: 2031,
});
// Enrollment-qualifying consent (v8+ copy, full save-and-charge source).
// Override version/source to model hold-only or legacy-implicit rows.
const CARD_CONSENT = (over = {}) => ({
  customer_id: 'cust-1',
  stripe_payment_method_id: 'pm_card_stripe',
  consent_text_version: 'v8_2026-06-08',
  source: 'pay_page',
  ...over,
});

// knex stub over the in-memory payment_methods rows so the REAL
// getChargeableAutopayMethod can query post-flip mockState.
const stubKnex = (table) => {
  const q = {
    _criteria: null,
    where(criteria) { q._criteria = criteria; return q; },
    async first() {
      if (table !== 'payment_methods') return null;
      return mockState.paymentMethodRows.find(
        (r) => Object.entries(q._criteria).every(([k, v]) => r[k] === v),
      ) || null;
    },
  };
  return q;
};

const PI = { id: 'pi_ach_1', metadata: { type: 'monthly_autopay' } };

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
});

describe('handleAchFailure — escalation error propagation', () => {
  test('an escalation write failure rejects so the event is redelivered (never acked-and-lost)', async () => {
    mockState.recentFailures = 2;
    mockState.failCustomerUpdate = true;

    await expect(handleAchFailure(PI, 'R01', 'evt_1')).rejects.toThrow('escalation write failed');
    // No customer SMS for an escalation that never committed.
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockHandleAutopayFailure).not.toHaveBeenCalled();
  });

  test('SMS provider failure stays non-critical — handler resolves, follow-up engine still notified', async () => {
    mockState.recentFailures = 1;
    mockSendCustomerMessage.mockRejectedValueOnce(new Error('twilio down'));

    await expect(handleAchFailure(PI, 'R01', 'evt_2')).resolves.toBeUndefined();
    expect(mockHandleAutopayFailure).toHaveBeenCalledWith('cust-1');
  });

  test('replayed event (already in ach_failure_log) skips SMS + follow-up side effects', async () => {
    mockState.achLogRow = { id: 'log-1' };

    await expect(handleAchFailure(PI, 'R01', 'evt_3')).resolves.toBeUndefined();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockHandleAutopayFailure).not.toHaveBeenCalled();
  });
});

describe('handleAchFailure — >=3 failures card fallback', () => {
  test('card fallback is complete: flags flipped on both rows, customer repointed, method chargeable', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), CARD_ROW()];
    mockState.consentRows = [CARD_CONSENT()];

    await handleAchFailure(PI, 'R01', 'evt_4');

    const bank = mockState.paymentMethodRows.find((r) => r.id === 'pm-bank');
    const card = mockState.paymentMethodRows.find((r) => r.id === 'pm-card');
    // Non-selected rows: BOTH flags cleared (customer-autopay PUT idiom).
    expect(bank.is_default).toBe(false);
    expect(bank.autopay_enabled).toBe(false);
    // The card carries BOTH flags — is_default alone is not chargeable.
    expect(card.is_default).toBe(true);
    expect(card.autopay_enabled).toBe(true);
    // Customer-level pointer follows the card in the same transaction.
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ autopay_payment_method_id: 'pm-card' }),
    );
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ ach_status: 'suspended' }),
    );

    // The collection predicate must now find the card — this is what
    // every future autopay charge calls before charging.
    const method = await getChargeableAutopayMethod({ id: 'cust-1' }, stubKnex);
    expect(method).toBeTruthy();
    expect(method.id).toBe('pm-card');
    expect(method.method_type).toBe('card');

    // The suspension SMS lane fired, deep-linking the real Billing tab
    // (query-param routed — the customer app has no /billing path).
    expect(mockRenderTemplate).toHaveBeenCalledWith(
      'ach_suspended',
      expect.objectContaining({ billing_url: 'https://portal.test/?tab=billing' }),
      expect.anything(),
    );
  });

  test('no card on file: ACH suspended AND autopay disarmed — the sweep cannot re-debit the dead bank (Codex round 2 P1)', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW()];

    await expect(handleAchFailure(PI, 'R01', 'evt_5')).resolves.toBeUndefined();

    const bank = mockState.paymentMethodRows.find((r) => r.id === 'pm-bank');
    // Display default stays (portal state), but the chargeable predicate
    // (is_default AND autopay_enabled) is broken method-side…
    expect(bank.is_default).toBe(true);
    expect(bank.autopay_enabled).toBe(false);
    expect(await getChargeableAutopayMethod({ id: 'cust-1' }, stubKnex)).toBeFalsy();
    // …and the retry sweep's stop condition is set customer-side, so the
    // armed retry_count/next_retry_at row parks instead of re-debiting.
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ autopay_enabled: false }),
    );
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ ach_status: 'suspended' }),
    );
    expect(mockState.customerUpdates.some((p) => p.autopay_payment_method_id)).toBe(false);
  });

  test('2 failures sends the verification notice, not a switch claim — no method flip happens', async () => {
    mockState.recentFailures = 2;
    mockState.paymentMethodRows = [BANK_ROW(), CARD_ROW()];

    await handleAchFailure(PI, 'R01', 'evt_6');

    const bank = mockState.paymentMethodRows.find((r) => r.id === 'pm-bank');
    const card = mockState.paymentMethodRows.find((r) => r.id === 'pm-card');
    expect(bank.is_default).toBe(true);
    expect(card.is_default).toBe(false);
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ ach_status: 'needs_verification' }),
    );
    expect(mockRenderTemplate).toHaveBeenCalledWith(
      'ach_card_fallback',
      expect.objectContaining({ billing_url: 'https://portal.test/?tab=billing' }),
      expect.anything(),
    );
  });
});

describe('handleAchFailure — consent-scoped fallback (enrollment consent required)', () => {
  const cardOf = () => mockState.paymentMethodRows.find((r) => r.id === 'pm-card');
  const bankOf = () => mockState.paymentMethodRows.find((r) => r.id === 'pm-bank');

  test('hold-only consent (estimate_card_hold) never promotes the card into Auto Pay', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), CARD_ROW()];
    mockState.consentRows = [CARD_CONSENT({ source: 'estimate_card_hold' })];

    await expect(handleAchFailure(PI, 'R01', 'evt_7')).resolves.toBeUndefined();

    // No flip anywhere: the hold-only card stays out of Auto Pay and the
    // account is deliberately left without a fallback.
    expect(cardOf().is_default).toBe(false);
    expect(cardOf().autopay_enabled).toBe(false);
    expect(bankOf().is_default).toBe(true);
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ ach_status: 'suspended' }),
    );
    expect(mockState.customerUpdates.some((p) => p.autopay_payment_method_id)).toBe(false);
  });

  test('pre-v8 consent copy does not authorize enrollment — no fallback', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), CARD_ROW()];
    mockState.consentRows = [CARD_CONSENT({ consent_text_version: 'v0_implicit_pre_consent' })];

    await handleAchFailure(PI, 'R01', 'evt_8');

    expect(cardOf().autopay_enabled).toBe(false);
    expect(mockState.customerUpdates.some((p) => p.autopay_payment_method_id)).toBe(false);
  });

  test('a later Auto Pay opt-out is honored — consented card still not promoted', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), CARD_ROW()];
    mockState.consentRows = [CARD_CONSENT()];
    mockState.lastAutopayToggle = { event_type: 'autopay_disabled' };

    await handleAchFailure(PI, 'R01', 'evt_9');

    expect(cardOf().autopay_enabled).toBe(false);
    expect(mockState.customerUpdates.some((p) => p.autopay_payment_method_id)).toBe(false);
  });

  test('consent lookup error fails closed: rejects for redelivery, no flip, no SMS', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), CARD_ROW()];
    mockState.consentRows = [CARD_CONSENT()];
    mockState.failConsentLookup = true;

    await expect(handleAchFailure(PI, 'R01', 'evt_10')).rejects.toThrow('consent lookup failed');

    expect(cardOf().autopay_enabled).toBe(false);
    expect(mockState.customerUpdates).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockHandleAutopayFailure).not.toHaveBeenCalled();
  });
});

// Codex round 2 (07-18, P2): the retry sweep charges whatever ends up
// default+enabled with no expiry re-check, so an expired card must never be
// promoted into Auto Pay by the ACH suspension flip. Junk expiry data reads
// as expired (same fail-closed rule as the portal enable gate); when only
// expired cards are consented, the no-fallback disarm path applies instead.
describe('handleAchFailure — expired-card fallback exclusion (Codex round 2)', () => {
  const cardOf = (id = 'pm-card') => mockState.paymentMethodRows.find((r) => r.id === id);

  test('an expired consented card is never promoted — autopay disarms instead', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), { ...CARD_ROW(), exp_year: 2024 }];
    mockState.consentRows = [CARD_CONSENT()];

    await handleAchFailure(PI, 'R01', 'evt_exp_1');

    expect(cardOf().is_default).toBe(false);
    expect(cardOf().autopay_enabled).toBe(false);
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ autopay_enabled: false }),
    );
    expect(mockState.customerUpdates.some((p) => p.autopay_payment_method_id)).toBe(false);
  });

  test('junk expiry data fails closed — treated as expired, no promotion', async () => {
    mockState.recentFailures = 3;
    mockState.paymentMethodRows = [BANK_ROW(), { ...CARD_ROW(), exp_month: null, exp_year: null }];
    mockState.consentRows = [CARD_CONSENT()];

    await handleAchFailure(PI, 'R01', 'evt_exp_2');

    expect(cardOf().autopay_enabled).toBe(false);
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ autopay_enabled: false }),
    );
  });

  test('a current consented card is still promoted past an expired one ahead of it', async () => {
    mockState.recentFailures = 3;
    const expiredDefault = {
      ...CARD_ROW(), id: 'pm-card-old', stripe_payment_method_id: 'pm_card_old', is_default: true, exp_year: 2024,
    };
    mockState.paymentMethodRows = [BANK_ROW(), expiredDefault, CARD_ROW()];
    mockState.consentRows = [CARD_CONSENT(), CARD_CONSENT({ stripe_payment_method_id: 'pm_card_old' })];

    await handleAchFailure(PI, 'R01', 'evt_exp_3');

    expect(cardOf().is_default).toBe(true);
    expect(cardOf().autopay_enabled).toBe(true);
    expect(cardOf('pm-card-old').autopay_enabled).toBe(false);
    expect(mockState.customerUpdates).toContainEqual(
      expect.objectContaining({ autopay_payment_method_id: 'pm-card' }),
    );
  });
});
