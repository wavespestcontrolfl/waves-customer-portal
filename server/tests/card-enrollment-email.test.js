/**
 * Card-enrollment confirmation emails — gate discipline + payload
 * composition. The senders are OWNER-GATED (GATE_CARD_ENROLLMENT_EMAILS)
 * and best-effort: off-gate they must be a total no-op (no DB reads, no
 * template sends), and on-gate they compose the authorization copy from
 * the stored consent ledger and the FROZEN hold-row terms.
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
    q.select = jest.fn(async () => rows);
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
const { CARD_CONSENT_TEXT } = require('../services/payment-method-consent-text');

const CUSTOMER = { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com' };
const CONSENT_V9 = {
  id: 'consent-77',
  source: 'pay_page',
  consent_text_version: 'v9_2026-07-12',
  consent_text_snapshot: 'SNAPSHOT: the exact text the customer agreed to (v9)',
  created_at: '2026-07-13T01:00:00Z',
};

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
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_stripe_1', card_brand: 'visa', last_four: '4242', method_type: 'card' }],
      payment_method_consents: [CONSENT_V9],
    };
  });
  afterAll(() => { delete process.env.GATE_CARD_ENROLLMENT_EMAILS; });

  test('sends the STORED consent snapshot with the card line (never the deployed text — Codex r1)', async () => {
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const call = mockSendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('autopay.enrollment_confirmation');
    expect(call.to).toBe('taylor@example.com');
    expect(call.payload.card_line).toBe('your Visa ending 4242');
    // The customer's copy is what THEY agreed to — the ledger snapshot; a
    // later consent-version wording bump must never rewrite their copy.
    expect(call.payload.authorization_text).toBe('SNAPSHOT: the exact text the customer agreed to (v9)');
    expect(call.payload.company_email).toBe('billing@wavespestcontrol.com');
    // Consent-VERSION-keyed (Codex r2 + r3): the /consent endpoint and the
    // Stripe webhook can race two rows onto one SetupIntent — both carry
    // the same deployed version, so version-keying collapses the duplicate
    // that row-id keying double-sent, while a version-bumped
    // re-authorization (new agreement text) still gets a fresh copy.
    expect(call.idempotencyKey).toBe('autopay.enrollment_confirmation:cust-1:pm-1:v9_2026-07-12');
  });

  test('race duplicates collapse: two same-version consent rows produce the same key (Codex r3)', async () => {
    state.tables.payment_method_consents = [
      { ...CONSENT_V9, id: 'consent-webhook', created_at: '2026-07-13T01:00:05Z' },
      { ...CONSENT_V9, id: 'consent-browser', created_at: '2026-07-13T01:00:04Z' },
    ];
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    // The key must not depend on WHICH racing row won the newest slot.
    expect(mockSendTemplate.mock.calls[0][0].idempotencyKey)
      .toBe('autopay.enrollment_confirmation:cust-1:pm-1:v9_2026-07-12');
  });

  test('a newer HOLD-scoped consent row never hijacks the Auto Pay copy (Codex r3)', async () => {
    state.tables.payment_method_consents = [
      {
        id: 'consent-hold',
        source: 'estimate_card_hold',
        consent_text_version: 'v9_2026-07-12',
        consent_text_snapshot: 'HOLD-ONLY visit-scoped terms',
        created_at: '2026-07-13T02:00:00Z',
      },
      CONSENT_V9,
    ];
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    // The hold row is newer, but it only authorizes one visit's completion
    // charge — the Auto Pay authorization copy must come from the
    // enrollment-scoped agreement.
    expect(mockSendTemplate.mock.calls[0][0].payload.authorization_text)
      .toBe('SNAPSHOT: the exact text the customer agreed to (v9)');
  });

  test('no enrollment-scoped consent row → SKIP, never a fabricated copy (Codex r3)', async () => {
    state.tables.payment_method_consents = [];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('legacy pre-v8 consent rows do not qualify — their copy never authorized recurring charges', async () => {
    state.tables.payment_method_consents = [{
      ...CONSENT_V9,
      consent_text_version: 'v7_2026-05-01',
      consent_text_snapshot: 'old plain card-on-file copy',
    }];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('unknown method families are skipped — no matching template, no send', async () => {
    state.tables.payment_methods = [{ id: 'pm-1', stripe_payment_method_id: 'pm_x_1', method_type: 'cashapp' }];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('no usable email → skip without sending', async () => {
    state.tables.customers = [{ id: 'cust-1', first_name: 'T', email: '' }];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('missing pm row → skip: no agreement of record, no authorization copy (Codex r3)', async () => {
    state.tables.payment_methods = [];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-x' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

describe('BANK enrollment confirmation (portal ACH lane)', () => {
  const BANK_PM = {
    id: 'pm-1',
    stripe_payment_method_id: 'pm_bank_1',
    method_type: 'ach',
    bank_name: 'Chase Bank',
    bank_last_four: '6789',
    last_four: '6789',
  };
  const ACH_CONSENT_V10 = {
    id: 'consent-88',
    source: 'portal_add_bank',
    consent_text_version: 'v10_2026-07-13',
    consent_text_snapshot: 'SNAPSHOT: the exact ACH debit authorization the customer agreed to (v10)',
    created_at: '2026-07-13T08:00:00Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_CARD_ENROLLMENT_EMAILS = 'true';
    state.tables = {
      customers: [CUSTOMER],
      payment_methods: [BANK_PM],
      payment_method_consents: [ACH_CONSENT_V10],
    };
  });
  afterAll(() => { delete process.env.GATE_CARD_ENROLLMENT_EMAILS; });

  test('bank enrollment sends the ACH template with debit wording — never card copy over a debit authorization', async () => {
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const call = mockSendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('autopay.enrollment_confirmation_ach');
    expect(call.payload.bank_line).toBe('your Chase Bank account ending 6789');
    expect(call.payload.debit_timing_line)
      .toBe("After each completed service, your bank account is debited that service's amount automatically, and you get a receipt every time.");
    // Never the card variables — the template's required set is bank-shaped.
    expect(call.payload.card_line).toBeUndefined();
    expect(call.payload.charge_timing_line).toBeUndefined();
    expect(call.payload.authorization_text).toBe('SNAPSHOT: the exact ACH debit authorization the customer agreed to (v10)');
    // Template-keyed + consent-version-keyed, same dedupe semantics as card.
    expect(call.idempotencyKey).toBe('autopay.enrollment_confirmation_ach:cust-1:pm-1:v10_2026-07-13');
  });

  test('monthly-billed bank accounts get the monthly DEBIT line', async () => {
    state.tables.customers = [{ ...CUSTOMER, billing_mode: null, monthly_rate: '120.00' }];
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    expect(mockSendTemplate.mock.calls[0][0].payload.debit_timing_line)
      .toBe('Your bank account is debited your monthly plan amount on your billing day each month, and you get a receipt every time.');
  });

  test('bank enrollment with no qualifying consent → skip (never fabricate an ACH authorization copy)', async () => {
    state.tables.payment_method_consents = [];
    expect(await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' })).toBe(null);
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });
});

describe('charge timing line by billing mode (Codex r3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_CARD_ENROLLMENT_EMAILS = 'true';
    state.tables = {
      customers: [CUSTOMER],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_stripe_1', card_brand: 'visa', last_four: '4242', method_type: 'card' }],
      payment_method_consents: [CONSENT_V9],
    };
  });
  afterAll(() => { delete process.env.GATE_CARD_ENROLLMENT_EMAILS; });

  async function timingLineFor(customerRow) {
    state.tables.customers = [customerRow];
    await sendAutopayEnrollmentConfirmation({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
    return mockSendTemplate.mock.calls[0][0].payload.charge_timing_line;
  }

  test('per-application (and default) accounts get the per-service line', async () => {
    expect(await timingLineFor({ ...CUSTOMER, billing_mode: 'per_application', monthly_rate: null }))
      .toBe("After each completed service, your card is charged that service's amount automatically, and you get a receipt every time.");
  });

  test('monthly-billed accounts get the monthly line — the cron charges monthly_rate, not per visit', async () => {
    expect(await timingLineFor({ ...CUSTOMER, billing_mode: null, monthly_rate: '89.00' }))
      .toBe('Your card is charged your monthly plan amount on your billing day each month, and you get a receipt every time.');
  });

  test('annual-prepay accounts get the as-agreed line — no cadence the prepaid term does not have', async () => {
    expect(await timingLineFor({ ...CUSTOMER, billing_mode: 'annual_prepay', monthly_rate: '89.00' }))
      .toBe('Your card is charged for your service invoices as agreed, and you get a receipt every time.');
  });

  test('explicit per-visit accounts get INVOICE wording, never the monthly or auto-charge promise (Codex r6+r7)', async () => {
    expect(await timingLineFor({ ...CUSTOMER, billing_mode: 'per_visit', monthly_rate: '89.00' }))
      .toBe('After each completed service, we send your invoice — your card on file makes paying it quick.');
  });

  test('explicit one-time accounts get INVOICE wording, never the monthly or auto-charge promise (Codex r6+r7)', async () => {
    expect(await timingLineFor({ ...CUSTOMER, billing_mode: 'one_time', monthly_rate: '89.00' }))
      .toBe('After each completed service, we send your invoice — your card on file makes paying it quick.');
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

  test('surcharge line carries the QUANTIFIED disclosure from the canonical consent copy (Codex r3)', async () => {
    await sendCardHoldConfirmation({ estimateId: 'est-1', customerId: 'cust-1' });
    const line = mockSendTemplate.mock.calls[0][0].payload.surcharge_line;
    // Extraction must work against the live consent copy — the customer
    // saw this same disclosure in the capture UI, and the rate must come
    // from the versioned consent module, never a second constant.
    const phrase = (CARD_CONSENT_TEXT.match(/up to \d+(?:\.\d+)?%/) || [])[0];
    expect(phrase).toBeTruthy();
    expect(line).toBe(`A credit card surcharge of ${phrase} may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.`);
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

describe('seeded template rows stay inside the admin route enums (Codex r3)', () => {
  const { _TEMPLATES } = require('../models/migrations/20260713010010_seed_card_enrollment_email_templates');
  const { _TEMPLATES: ACH_TEMPLATES } = require('../models/migrations/20260713100010_seed_ach_enrollment_email_template');

  test('content sensitivity is a member of the admin SENSITIVITIES enum', () => {
    // Mirror of SENSITIVITIES in routes/admin-email-templates.js — an
    // out-of-enum seed makes every later admin save of the template fail
    // validation.
    const allowed = new Set(['normal', 'financial', 'account', 'health_safety', 'property_sensitive']);
    for (const t of [..._TEMPLATES, ...ACH_TEMPLATES]) {
      expect(allowed.has(t.sensitivity)).toBe(true);
    }
  });

  test('sender-composed lines are declared as required template variables', () => {
    const byKey = Object.fromEntries([..._TEMPLATES, ...ACH_TEMPLATES].map((t) => [t.key, t]));
    expect(byKey['autopay.enrollment_confirmation'].required).toContain('charge_timing_line');
    expect(byKey['cardhold.confirmation'].required).toContain('surcharge_line');
    expect(byKey['autopay.enrollment_confirmation_ach'].required)
      .toEqual(expect.arrayContaining(['bank_line', 'debit_timing_line', 'authorization_text']));
  });
});
