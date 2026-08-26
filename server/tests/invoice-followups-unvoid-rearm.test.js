// scheduleForInvoice re-arm branch (Codex #3493 r2): an unvoided invoice
// keeps voidInvoice's SYSTEM stop ('invoice_voided', no admin id) while it
// sits in draft; the RESEND calls scheduleForInvoice, which lifts exactly
// that stop under the invoice lock — restoring the autopay hold instead of
// activating dunning for autopay customers, and never touching an admin's
// own stop/pause.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {} }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({
  sendMicrodepositVerificationEmail: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(),
  invoiceShortCodePrefix: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));

const db = require('../models/db');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { scheduleForInvoice } = require('../services/invoice-followups');

function voidStoppedSeq(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    status: 'stopped',
    stopped_reason: 'invoice_voided',
    stopped_by_admin_id: null,
    is_autopay_held: false,
    step_index: 0,
    anchor_at: new Date().toISOString(),
    ...overrides,
  };
}

function setupDb({ seq, invoice, rearmed }) {
  const seqUpdate = jest.fn(() => ({ returning: jest.fn(async () => (rearmed ? [rearmed] : [])) }));
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences') {
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        first: jest.fn(async () => seq),
        update: seqUpdate,
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        forUpdate: jest.fn(() => q),
        first: jest.fn(async () => invoice),
      };
      return q;
    }
    if (table === 'customers') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ id: 'cust-1' })) };
      return q;
    }
    if (table === 'payment_plans') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => undefined) };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { seqUpdate };
}

const sentInvoice = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', created_at: new Date().toISOString() };

describe('scheduleForInvoice — unvoid re-arm of the system void stop', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lifts the invoice_voided system stop to active with a computed next touch', async () => {
    const rearmed = voidStoppedSeq({ status: 'active', stopped_reason: null });
    const { seqUpdate } = setupDb({ seq: voidStoppedSeq(), invoice: sentInvoice, rearmed });
    customerOnAutopay.mockResolvedValue(false);

    const row = await scheduleForInvoice('inv-1');

    expect(row).toBe(rearmed);
    const payload = seqUpdate.mock.calls[0][0];
    expect(payload.status).toBe('active');
    expect(payload.stopped_reason).toBeNull();
    expect(payload.stopped_by_admin_id).toBeNull();
    expect(payload.is_autopay_held).toBe(false);
    expect(payload.next_touch_at).toBeTruthy();
  });

  test('restores autopay_hold (never active dunning) when the row was autopay-held before the void', async () => {
    const seq = voidStoppedSeq({ is_autopay_held: true });
    const rearmed = { ...seq, status: 'autopay_hold', stopped_reason: null };
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice, rearmed });
    customerOnAutopay.mockResolvedValue(false);

    await scheduleForInvoice('inv-1');

    const payload = seqUpdate.mock.calls[0][0];
    expect(payload.status).toBe('autopay_hold');
    expect(payload.is_autopay_held).toBe(true);
    expect(payload.next_touch_at).toBeNull();
  });

  test('re-checks autopay standing live — a customer enrolled while stopped holds too', async () => {
    const { seqUpdate } = setupDb({ seq: voidStoppedSeq(), invoice: sentInvoice, rearmed: voidStoppedSeq() });
    customerOnAutopay.mockResolvedValue(true);

    await scheduleForInvoice('inv-1');

    const payload = seqUpdate.mock.calls[0][0];
    expect(payload.status).toBe('autopay_hold');
    expect(payload.next_touch_at).toBeNull();
  });

  test('an exhausted cadence restores terminal completed so the legacy checker owns the invoice', async () => {
    const seq = voidStoppedSeq({ step_index: 99 });
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice, rearmed: seq });
    customerOnAutopay.mockResolvedValue(false);

    await scheduleForInvoice('inv-1');

    const payload = seqUpdate.mock.calls[0][0];
    expect(payload.status).toBe('completed');
    expect(payload.next_touch_at).toBeNull();
  });

  test("an admin's own stop is returned untouched — no update runs", async () => {
    const adminStop = voidStoppedSeq({ stopped_by_admin_id: 'admin-1' });
    const { seqUpdate } = setupDb({ seq: adminStop, invoice: sentInvoice });

    const row = await scheduleForInvoice('inv-1');

    expect(row).toBe(adminStop);
    expect(seqUpdate).not.toHaveBeenCalled();
  });

  test('a stop with any other reason is returned untouched — no update runs', async () => {
    const planStop = voidStoppedSeq({ stopped_reason: 'payment_plan_created:pp-1' });
    const { seqUpdate } = setupDb({ seq: planStop, invoice: sentInvoice });

    const row = await scheduleForInvoice('inv-1');

    expect(row).toBe(planStop);
    expect(seqUpdate).not.toHaveBeenCalled();
  });

  test('a lost conditional re-arm (admin stop raced in) returns the pre-read row instead of fabricating one', async () => {
    const seq = voidStoppedSeq();
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice, rearmed: null });
    customerOnAutopay.mockResolvedValue(false);

    const row = await scheduleForInvoice('inv-1');

    expect(seqUpdate).toHaveBeenCalled();
    expect(row).toBe(seq);
  });
});
