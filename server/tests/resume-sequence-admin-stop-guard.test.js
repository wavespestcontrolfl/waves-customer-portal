// Audit repro r2-scheduler-comms-crons-and-review-sequences-2 (ADMIN-BUG-R54),
// adjusted to the brief's judge-corrected fix location.
//
// Bug: an ADMIN stop ('stopped' with a stopped_reason + stopped_by_admin_id)
// survives apply-credit because stopOnPayment skips already-'stopped' rows
// (invoice-followups.js:1222), and the reverse-prepaid route / the
// annual-prepay coverage reopen then called resumeSequence(id)
// unconditionally, which flips the row to 'active' and nulls both stop
// fields, erasing who stopped dunning and why.
//
// Fix location (per the brief's judge correction): NOT a blanket status
// guard inside resumeSequence itself — POST /:id/followup/resume is the one
// legitimate path where an operator explicitly asks to lift ANY stop
// (admin or system), and resumeSequence must keep serving that unconditional
// lift. Instead, the two AUTOMATIC re-arm callers (reverse-prepaid,
// reopenAnnualPrepayCoveredInvoicesForTerm) must consult the new
// FollowUps.canSystemResumeInvoice guard before ever calling resumeSequence,
// so they only lift a stop the settlement itself created — never an admin's
// or a payment-plan's stop that happens to still be in place.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: () => false,
}));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {} }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));
jest.mock('../services/pay-combined', () => ({
  lockCombinedCustomers: jest.fn(async () => undefined),
  isCombinedPiMetadata: jest.fn(() => false),
  paymentIntentOwnsInvoice: jest.fn(() => false),
  clearPaymentIntentStamps: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const { resumeSequence, stopOnPayment, canSystemResumeInvoice } = require('../services/invoice-followups');

function setupDb({ seq, invoice }) {
  const seqUpdate = jest.fn(async () => 1);
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => seq), update: seqUpdate };
      return q;
    }
    if (table === 'invoices') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => invoice) };
      return q;
    }
    if (table === 'customers') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ id: 'cust-1' })) };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { seqUpdate };
}

const sentInvoice = { id: 'inv-1', status: 'sent', created_at: new Date().toISOString(), due_date: new Date().toISOString() };

describe('resumeSequence vs an explicit stop (audit repro, corrected fix location)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stopOnPayment leaves an admin stop intact (so the stop survives apply-credit)', async () => {
    const seq = { id: 'seq-1', customer_id: 'cust-1', status: 'stopped', stopped_reason: 'mailed check', stopped_by_admin_id: 'adm', touches_sent: 1 };
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice });
    await stopOnPayment('inv-1');
    expect(seqUpdate).not.toHaveBeenCalled();
  });

  test('canSystemResumeInvoice refuses an ADMIN-stopped row — a system re-arm caller must not resume it', async () => {
    const seq = { id: 'seq-1', status: 'stopped', stopped_reason: 'mailed check', stopped_by_admin_id: 'adm' };
    setupDb({ seq, invoice: sentInvoice });
    expect(await canSystemResumeInvoice('inv-1')).toBe(false);
  });

  test('canSystemResumeInvoice refuses a payment_plan_created:* stopped row', async () => {
    const seq = { id: 'seq-1', status: 'stopped', stopped_reason: 'payment_plan_created:plan-9:prev=active', stopped_by_admin_id: null };
    setupDb({ seq, invoice: sentInvoice });
    expect(await canSystemResumeInvoice('inv-1')).toBe(false);
  });

  test('canSystemResumeInvoice allows a naturally COMPLETED row (ordinary apply-credit / reverse-prepaid settle)', async () => {
    const seq = { id: 'seq-1', status: 'completed', stopped_reason: null, stopped_by_admin_id: null };
    setupDb({ seq, invoice: sentInvoice });
    expect(await canSystemResumeInvoice('inv-1')).toBe(true);
  });

  test('canSystemResumeInvoice allows the annual-prepay coverage SYSTEM stamp with no admin attribution', async () => {
    const seq = { id: 'seq-1', status: 'stopped', stopped_reason: 'annual_prepay_covered', stopped_by_admin_id: null };
    setupDb({ seq, invoice: sentInvoice });
    expect(await canSystemResumeInvoice('inv-1')).toBe(true);
  });

  test('an ADMIN-stopped row must not be re-armed to active BY THE SYSTEM RE-ARM PATH (only resumeSequence when canSystemResumeInvoice allows it)', async () => {
    const seq = {
      id: 'seq-1', customer_id: 'cust-1', status: 'stopped',
      stopped_reason: 'mailed check', stopped_by_admin_id: 'adm',
      is_autopay_held: false, step_index: 0, anchor_at: new Date().toISOString(),
    };
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice });

    // This is the guarded call shape both reverse-prepaid and the
    // annual-prepay reopen now use.
    if (await canSystemResumeInvoice('inv-1')) {
      await resumeSequence('inv-1');
    }

    expect(seqUpdate).not.toHaveBeenCalled();
  });

  test('resumeSequence itself stays UNCONDITIONAL — POST /:id/followup/resume still lifts an admin stop on explicit operator request', async () => {
    const seq = {
      id: 'seq-1', customer_id: 'cust-1', status: 'stopped',
      stopped_reason: 'mailed check', stopped_by_admin_id: 'adm',
      is_autopay_held: false, step_index: 0, anchor_at: new Date().toISOString(),
    };
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice });
    // The explicit resume route calls resumeSequence directly, with no guard.
    await resumeSequence('inv-1');
    const payload = seqUpdate.mock.calls[0]?.[0];
    expect(payload.status).toBe('active');
    expect(payload.stopped_reason).toBeNull();
    expect(payload.stopped_by_admin_id).toBeNull();
  });
});
