/**
 * Purpose payer_payment_link (GATE_PAYER_INVOICE_SMS): the recipient must be the ACTIVE payer's ap_phone for the invoice's
 * payer_id, read fresh at the pipeline and again at the provider handoff. The validator is unit-tested against a table-keyed
 * fake; the WIRING (pipeline step + boundary re-check in send-customer-message) is tested with the same mocked pipeline the
 * contact-prefs boundary suite uses.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(() => false) };
});
jest.mock('../services/messaging/validators/consent', () => ({
  ...jest.requireActual('../services/messaging/validators/consent'),
  loadContactState: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({ checkLineType: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/messaging/validators/voice', () => ({ validateNoCustomerEmoji: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/messaging/compliance-contact-checks', () => ({ checkContactCompliance: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: jest.fn(async () => ({ id: 'audit-1' })) }));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberBlocksSend: jest.fn(async () => false) }));

const db = require('../models/db');
const { resolvePolicy } = require('../services/messaging/policy');
const { checkPayerRecipient, payerTextInvoiceProblem } = require('../services/messaging/validators/payer-recipient');
const { checkConsentForPurpose } = require('../services/messaging/validators/consent');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');

const policy = resolvePolicy('customer', 'payer_payment_link');
const INPUT = {
  to: '+19415550123',
  body: 'Hi Pat! The invoice is ready: portal.wavespestcontrol.com/l/x',
  channel: 'sms',
  audience: 'customer',
  purpose: 'payer_payment_link',
  customerId: 'cust-1',
  invoiceId: 'inv-1',
  metadata: { original_message_type: 'payer_invoice' },
};

let rows;
function fakeDb() {
  return jest.fn((table) => {
    const q = {};
    ['where', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => {
      const row = rows[table];
      if (row instanceof Error) throw row;
      return row;
    });
    return q;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = {
    invoices: { id: 'inv-1', customer_id: 'cust-1', payer_id: 7, payer_statement_id: null, status: 'sending', total: '150.00', credit_applied: 0, amount_paid: 0, scheduled_send_error: null },
    payers: { id: 7, active: true, ap_phone: '(941) 555-0123' },
  };
  db.mockImplementation(fakeDb());
});

describe('policy', () => {
  test('is a distinct purpose that proves the payer phone and reads no homeowner consent', () => {
    expect(policy).toMatchObject({ requirePayerPhoneMatch: true, requireConsent: 'none', requireIds: ['customerId', 'invoiceId'] });
    expect(resolvePolicy('customer', 'payment_link').requirePayerPhoneMatch).toBeUndefined();
  });

  test('a homeowner STOP does not stop a text to the payer; it does stop the homeowner\'s own pay link', async () => {
    const contactState = { prefs: { sms_enabled: false }, customer: { id: 'cust-1' }, suppressionLoaded: true };
    await expect(checkConsentForPurpose(INPUT, policy, contactState)).resolves.toEqual({ ok: true });
    await expect(checkConsentForPurpose({ ...INPUT, purpose: 'payment_link' }, resolvePolicy('customer', 'payment_link'), contactState))
      .resolves.toMatchObject({ ok: false, code: 'SMS_OPTED_OUT' });
  });
});

describe('checkPayerRecipient', () => {
  test('passes the active payer\'s own AP phone, in any stored format', async () => {
    await expect(checkPayerRecipient(INPUT, policy)).resolves.toEqual({ ok: true });
    rows.payers.ap_phone = '1-941-555-0123';
    await expect(checkPayerRecipient(INPUT, policy)).resolves.toEqual({ ok: true });
  });

  test('is a no-op for every other purpose', async () => {
    await expect(checkPayerRecipient({ ...INPUT, to: '+19415559999' }, resolvePolicy('customer', 'payment_link'))).resolves.toEqual({ ok: true });
    expect(db).not.toHaveBeenCalled();
  });

  test('refuses the customer\'s phone or any number that is not the payer\'s', async () => {
    await expect(checkPayerRecipient({ ...INPUT, to: '+19415550111' }, policy)).resolves.toMatchObject({ ok: false, code: 'PAYER_RECIPIENT_MISMATCH', deliveryOutcome: 'not_sent' });
    await expect(checkPayerRecipient({ ...INPUT, to: 'anonymous' }, policy)).resolves.toMatchObject({ ok: false, code: 'PAYER_RECIPIENT_MISMATCH' });
  });

  test.each([
    ['inactive payer', () => { rows.payers.active = false; }, 'PAYER_INACTIVE'],
    ['missing payer', () => { rows.payers = undefined; }, 'PAYER_INACTIVE'],
    ['payer without a phone', () => { rows.payers.ap_phone = ''; }, 'PAYER_PHONE_MISSING'],
    ['a payer edited to another phone', () => { rows.payers.ap_phone = '941-555-7777'; }, 'PAYER_RECIPIENT_MISMATCH'],
    ['an invoice that is not payer-billed', () => { rows.invoices.payer_id = null; }, 'NOT_PAYER_INVOICE'],
    ['an invoice of another customer', () => { rows.invoices.customer_id = 'cust-2'; }, 'PAYER_RECIPIENT_MISMATCH'],
    ['a paid invoice', () => { rows.invoices.status = 'paid'; }, 'INVOICE_NOT_OPEN'],
    ['a void invoice', () => { rows.invoices.status = 'void'; }, 'INVOICE_NOT_OPEN'],
    ['a statement-accrued invoice', () => { rows.invoices.payer_statement_id = 3; }, 'STATEMENT_ACCRUED'],
    ['a missing invoice', () => { rows.invoices = undefined; }, 'INVOICE_NOT_FOUND'],
  ])('refuses %s', async (_name, mutate, code) => {
    mutate();
    await expect(checkPayerRecipient(INPUT, policy)).resolves.toMatchObject({ ok: false, code });
  });

  test('fails closed and retryable when the rows cannot be read', async () => {
    rows.invoices = new Error('db down');
    await expect(checkPayerRecipient(INPUT, policy)).resolves.toMatchObject({ ok: false, code: 'PAYER_RECIPIENT_LOOKUP_FAILED', retryable: true });
  });

  test('payerTextInvoiceProblem is the one rule', () => {
    expect(payerTextInvoiceProblem(rows.invoices)).toBeNull();
    expect(payerTextInvoiceProblem({ ...rows.invoices, scheduled_send_error: 'payer_billed: moved' })).toMatchObject({ code: 'INVOICE_WITHDRAWN' });
  });
});

describe('wiring in send-customer-message', () => {
  // Real Twilio awaits the preSendCheck hook immediately before messages.create(); the mock does the same.
  const runViaProviderHook = () => sendViaTwilio.mockImplementation(async (_input, hooks) => {
    const verdict = await hooks.preSendCheck();
    if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'b'.repeat(32)}` };
  });

  beforeEach(() => { runViaProviderHook(); });

  test('the payer\'s AP phone goes out', async () => {
    const result = await sendCustomerMessage(INPUT);
    expect(result.sent).toBe(true);
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('the customer\'s phone is refused before the provider', async () => {
    const result = await sendCustomerMessage({ ...INPUT, to: '+19415550111' });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'PAYER_RECIPIENT_MISMATCH' });
    expect(sendViaTwilio).not.toHaveBeenCalled();
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['check_payer_recipient'] }));
  });

  test('a payer edited while the send was prepared is refused at the provider handoff', async () => {
    sendViaTwilio.mockImplementation(async (_input, hooks) => {
      rows.payers.ap_phone = '941-555-7777'; // the office edits the payer after the pipeline passed
      const verdict = await hooks.preSendCheck();
      return verdict.ok
        ? { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'c'.repeat(32)}` }
        : { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    });
    const result = await sendCustomerMessage(INPUT);
    expect(result.sent).toBe(false);
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
      validatorsFailed: expect.arrayContaining(['payer_recipient_boundary']),
    }));
  });

  test('an invoice paid while the send was prepared is refused at the provider handoff', async () => {
    sendViaTwilio.mockImplementation(async (_input, hooks) => {
      rows.invoices.status = 'paid';
      const verdict = await hooks.preSendCheck();
      return verdict.ok
        ? { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'d'.repeat(32)}` }
        : { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    });
    const result = await sendCustomerMessage(INPUT);
    expect(result.sent).toBe(false);
  });
});
