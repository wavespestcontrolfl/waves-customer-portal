// rescheduleForInvoiceEdit — shifts an ACTIVE sequence's whole timeline by
// the due-date delta (2026-07-17 delivered-invoice edit lane). The anchor
// lands on invoice_followup_sequences.anchor_at so fireStep progression
// stays on the same shifted timeline (one-timeline contract; re-anchoring
// only the current step would burst later steps on consecutive cron runs).
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
// ../config/invoice-followups stays REAL — the cadence table (3/7/14/30 days
// after send, 10 AM NY) is the contract under test.

const db = require('../models/db');
const { rescheduleForInvoiceEdit } = require('../services/invoice-followups');

function setupDb({ seq, invoice }) {
  const seqUpdate = jest.fn(async () => 1);
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences') {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => seq),
        update: seqUpdate,
      };
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

describe('rescheduleForInvoiceEdit shifts the whole cadence by the due-date delta', () => {
  beforeEach(() => jest.clearAllMocks());

  it('moves anchor_at and next_touch_at by +30 days when the due date moves +30 days', async () => {
    // Sent 2026-07-01 11:00 EDT, sequence sitting on the d7 step (index 1).
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'active', step_index: 1, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z', due_date: '2026-08-14' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-07-15',
      newDueDate: '2026-08-14',
    });
    expect(seqUpdate).toHaveBeenCalledTimes(1);
    const patch = seqUpdate.mock.calls[0][0];
    // Anchor: sent_at + 30 days.
    expect(patch.anchor_at.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    // d7 step off the shifted anchor: NY day 2026-07-31 + 7 → Aug 7, 10 AM EDT.
    expect(patch.next_touch_at.toISOString()).toBe('2026-08-07T14:00:00.000Z');
  });

  it('compounds a second shift from the stored anchor_at, not from sent_at', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'active', step_index: 0, anchor_at: new Date('2026-07-31T15:00:00Z') },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z', due_date: '2026-08-21' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-08-14',
      newDueDate: '2026-08-21',
    });
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.anchor_at.toISOString()).toBe('2026-08-07T15:00:00.000Z');
  });

  it('is a no-op when the due date is unchanged', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'active', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-07-15',
      newDueDate: '2026-07-15',
    });
    expect(db).not.toHaveBeenCalled();
    expect(seqUpdate).not.toHaveBeenCalled();
  });

  it('leaves non-active sequences (paused/held/stopped) alone — their release paths re-anchor', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'paused', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-07-15',
      newDueDate: '2026-08-14',
    });
    expect(seqUpdate).not.toHaveBeenCalled();
  });
});
