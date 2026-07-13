/**
 * Card-enrollment confirmation emails — gate discipline + payload
 * composition. The senders are OWNER-GATED (GATE_CARD_ENROLLMENT_EMAILS)
 * and best-effort: off-gate they must be a total no-op (no DB reads, no
 * template sends), and on-gate they compose the authorization copy from
 * the locked consent module and the FROZEN hold-row terms.
 */
const mockSendTemplate = jest.fn(async () => ({ sent: true }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...a) => mockSendTemplate(...a),
  redactEmailAddresses: (s) => s,
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const state = { tables: {} };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const rows = state.tables[table] || [];
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNotNull = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.first = jest.fn(async () => rows[0] || null);
    return q;
  });
  db.__state = state;
  return db;
});

const {
  sendAutopayEnrollmentConfirmation,
  sendCardHoldConfirmation,
  _private,
} = require('../services/card-enrollment-email');
const { getConsentText } = require('../services/payment-method-consent-text');

const CUSTOMER = { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com' };

describe('gate discipline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_CARD_ENROLLMENT_EMAILS;
    state.tables = {};
  });

  test('OFF by default: both senders are total no-ops', async () => {
    state.tables = { customers: [CUSTOMER] };
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(await sendCardHoldConfirmation({ estimateId: 'est-1', customerId: 'cust-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(_private.emailsEnabled()).toBe(false);
  });

  test('only the literal string true opens the gate', () => {
    process.env.GATE_CARD_ENROLLMENT_EMAILS = '1';
    expect(_private.emailsEnabled()).toBe(false);
    process.env.GATE_CARD_ENROLLMENT_EMAILS = 'true';
    expect(_private.emailsEnabled()).toBe(true);
  });
});

describe('autopay enrollment confirmation (gate on)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_CARD_ENROLLMENT_EMAILS = 'true';
    state.tables = {
      customers: [CUSTOMER],
      payment_methods: [{ id: 'pm-1', card_brand: 'visa', last_four: '4242', method_type: 'card' }],
    };
  });
  afterAll(() => { delete process.env.GATE_CARD_ENROLLMENT_EMAILS; });

  test('sends the card consent text verbatim with the card line', async () => {
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const call = mockSendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('autopay.enrollment_confirmation');
    expect(call.to).toBe('taylor@example.com');
    expect(call.payload.card_line).toBe('your Visa ending 4242');
    // The customer's copy is the EXACT locked text the checkbox rendered.
    expect(call.payload.authorization_text).toBe(getConsentText('card'));
    expect(call.payload.company_email).toBe('billing@wavespestcontrol.com');
    expect(call.idempotencyKey).toBe('autopay.enrollment_confirmation:cust-1:pm-1');
  });

  test('no usable email → skip without sending', async () => {
    state.tables.customers = [{ id: 'cust-1', first_name: 'T', email: '' }];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('missing pm row degrades the card line, never blocks', async () => {
    state.tables.payment_methods = [];
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-x' });
    expect(mockSendTemplate.mock.calls[0][0].payload.card_line).toBe('your card on file');
  });
});

describe('card-hold confirmation (gate on)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_CARD_ENROLLMENT_EMAILS = 'true';
    state.tables = {
      customers: [CUSTOMER],
      estimate_card_holds: [{ no_show_fee_amount: '49.00', cancel_window_hours: 24, stripe_payment_method_id: 'pm_stripe_1' }],
      payment_methods: [{ card_brand: 'mastercard', last_four: '5100' }],
    };
  });
  afterAll(() => { delete process.env.GATE_CARD_ENROLLMENT_EMAILS; });

  test('fee line comes from the FROZEN hold-row terms', async () => {
    await sendCardHoldConfirmation({ estimateId: 'est-1', customerId: 'cust-1' });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const call = mockSendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('cardhold.confirmation');
    expect(call.payload.fee_line).toBe('A $49.00 fee applies only if you cancel within 24 hours of your visit or we cannot get access.');
    expect(call.payload.card_line).toBe('your Mastercard ending 5100');
    expect(call.idempotencyKey).toBe('cardhold.confirmation:est-1');
  });

  test('no held row → skip without sending', async () => {
    state.tables.estimate_card_holds = [];
    expect(await sendCardHoldConfirmation({ estimateId: 'est-1', customerId: 'cust-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('sendTemplate failure is swallowed (best-effort contract)', async () => {
    mockSendTemplate.mockRejectedValueOnce(new Error('sendgrid down'));
    expect(await sendCardHoldConfirmation({ estimateId: 'est-1', customerId: 'cust-1' })).toBe(null);
  });
});
