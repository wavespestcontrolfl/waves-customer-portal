// AUDIT REPRO r2-scheduler-comms-crons-and-review-sequences-1
// releaseFromAutopayHold / resumeSequence anchor the re-armed step to
// invoice.due_date (default sent+30d) instead of the send anchor every
// other arming path uses (scheduleForInvoice, fireStep progression,
// skipStaleTouches, the unvoid re-arm, rescheduleForInvoiceEdit).
// EXPECTED (send-anchored): step 0 on a Jul 1 send lands Jul 4 10:00 NY.
// ACTUAL: due_date Jul 31 + 3 → Aug 2/3 — a month of silent dunning.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: (invoice) => /^payer_billed:/.test(String(invoice?.scheduled_send_error || '')),
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

const db = require('../models/db');
const { resumeSequence, releaseFromAutopayHold } = require('../services/invoice-followups');

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
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { seqUpdate };
}

// Sent Jul 1 2026 15:00Z (11:00 EDT); default due_date = +30d = Jul 31.
const invoice = {
  id: 'inv-1', status: 'sent',
  sent_at: '2026-07-01T15:00:00Z', created_at: '2026-07-01T15:00:00Z',
  due_date: '2026-07-31',
};

describe('release paths must re-arm from the send anchor (same timeline as every other arming path)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('releaseFromAutopayHold at step 0 lands the d3 nudge 3 days after SEND, not after the due date', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'autopay_hold', step_index: 0, anchor_at: null, is_autopay_held: true },
      invoice,
    });
    await releaseFromAutopayHold('inv-1');
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.status).toBe('active');
    // sent Jul 1 + 3 → Jul 4 10:00 EDT = 14:00Z
    expect(patch.next_touch_at.toISOString()).toBe('2026-07-04T14:00:00.000Z');
  });

  it('resumeSequence at step 1 lands the d7 reminder 7 days after SEND, not after the due date', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'paused', step_index: 1, anchor_at: null, is_autopay_held: false },
      invoice,
    });
    await resumeSequence('inv-1');
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.status).toBe('active');
    // sent Jul 1 + 7 → Jul 8 10:00 EDT = 14:00Z
    expect(patch.next_touch_at.toISOString()).toBe('2026-07-08T14:00:00.000Z');
  });
});
