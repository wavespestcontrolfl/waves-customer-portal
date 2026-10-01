/**
 * The operator send-now's dispute-hold exemption reaches the policy consult (Codex #5432 r16): the REAL
 * rail guard and the REAL collection-hold predicate run under sendReminderChannels; only the database
 * (a fake serving collections_flags) and the contact ledger are stand-ins. GATE_COLLECTIONS_POLICY is
 * OFF, the case the hold precheck alone decides. Synthetic data only.
 */
let mockHold = null; // null | { kind: 'dispute' | 'fallback' }
jest.mock('../models/db', () => {
  const fake = jest.fn((table) => {
    let exempt = false;
    const chain = {
      where(cond) { if (typeof cond === 'function') exempt = true; return chain; },
      whereNull() { return chain; },
      whereRaw() { return chain; },
      select() { return chain; },
      first: async () => (table === 'collections_flags' && mockHold && !(exempt && mockHold.kind === 'dispute') ? { id: 'hold-1' } : undefined),
      then: (resolve) => resolve([]),
    };
    return chain;
  });
  return fake;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/billing-email-reservation', () => ({ repairAcceptedBillingEmailReservations: jest.fn(async () => new Set()) }));
const mockLedger = [];
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async ({ channel, idempotencyKey, metadata }) => {
    const row = { id: `led-${mockLedger.length + 1}`, channel, idempotencyKey, metadata: { ...metadata } };
    mockLedger.push(row);
    return { id: row.id, metadata: { ...row.metadata } };
  }),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
  markDelivered: jest.fn(async () => true),
  markSendFailed: jest.fn(async () => true),
  releaseHeldReservation: jest.fn(async () => true),
}));

const { sendReminderChannels, reminderPolicyVerdicts } = require('../services/billing-reminder-delivery');

const CUSTOMER_ID = 'cust-0000-synthetic';
const base = (extra = {}) => ({
  customerId: CUSTOMER_ID, invoiceId: null, invoiceIds: ['inv-a', 'inv-b'], policyInvoiceIds: ['inv-a', 'inv-b'],
  source: 'invoice_followups_customer', purpose: 'late_payment', eventKey: 'customer-dunning:s1:1:d60_reminder',
  channels: ['email', 'sms'], metadata: {}, ...extra,
});
const accepting = () => jest.fn(async () => ({ sent: true, ok: true, deliveryOutcome: 'accepted' }));

beforeEach(() => {
  delete process.env.GATE_COLLECTIONS_POLICY;
  mockHold = null;
  mockLedger.length = 0;
});

describe('holdExempt reaches the real policy consult (sendReminderChannels)', () => {
  test('operator send-now under a plain DISPUTE hold: both legs are permitted and sent', async () => {
    mockHold = { kind: 'dispute' };
    const send = accepting();
    const out = await sendReminderChannels(base({ send, holdExempt: 'operator' }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(out.deliveredNow.sort()).toEqual(['email', 'sms']);
    expect(out.complete).toBe(true);
  });

  test('operator send-now under a wrong-party FALLBACK hold: still refused, nothing sent', async () => {
    mockHold = { kind: 'fallback' };
    const send = accepting();
    const out = await sendReminderChannels(base({ send, holdExempt: 'operator' }));
    expect(send).not.toHaveBeenCalled();
    expect(out.deliveredNow).toEqual([]);
    expect(out.results.email).toMatchObject({ code: 'COLLECTIONS_POLICY', blocked: true });
    expect(out.results.sms).toMatchObject({ code: 'COLLECTIONS_POLICY', blocked: true });
  });

  test('a scheduled (non-operator) send under a DISPUTE hold: refused, nothing sent', async () => {
    mockHold = { kind: 'dispute' };
    const send = accepting();
    const out = await sendReminderChannels(base({ send }));
    expect(send).not.toHaveBeenCalled();
    expect(out.results.sms).toMatchObject({ code: 'COLLECTIONS_POLICY' });
    expect(mockLedger).toHaveLength(0); // no reservation was taken
  });

  test('no hold: unchanged for everyone', async () => {
    const send = accepting();
    await sendReminderChannels(base({ send }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('the policy helper shadow shares: holdExempt only when given', async () => {
    mockHold = { kind: 'dispute' };
    const args = { customerId: CUSTOMER_ID, invoiceId: null, invoiceIds: ['inv-a'], source: 'invoice_followups_customer', purpose: 'late_payment', entries: [] };
    expect((await reminderPolicyVerdicts(args, ['sms']))[0]).toMatchObject({ allowed: false, hold: true });
    expect((await reminderPolicyVerdicts({ ...args, holdExempt: 'operator' }, ['sms']))[0]).toMatchObject({ allowed: true });
    mockHold = { kind: 'fallback' };
    expect((await reminderPolicyVerdicts({ ...args, holdExempt: 'operator' }, ['sms']))[0]).toMatchObject({ allowed: false, hold: true });
  });
});
