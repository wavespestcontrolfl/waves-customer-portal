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
const {
  rescheduleForInvoiceEdit,
  resumeSequence,
  releaseFromAutopayHold,
} = require('../services/invoice-followups');

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
    // Anchor: sent NY day Jul 1 + 30 → NY day Jul 31, pinned at noon UTC
    // (the cadence only consumes the anchor's NY calendar date).
    expect(patch.anchor_at.toISOString()).toBe('2026-07-31T12:00:00.000Z');
    // d7 step off the shifted anchor: NY day 2026-07-31 + 7 → Aug 7, 10 AM EDT.
    expect(patch.next_touch_at.toISOString()).toBe('2026-08-07T14:00:00.000Z');
  });

  it('advances by Eastern calendar days across the spring DST boundary, not by 24-hour periods', async () => {
    // Sent Sat 2026-03-07 11:30 PM EST (= 2026-03-08T04:30Z). +24h lands
    // 12:30 AM EDT on Mar 9 (DST starts Mar 8) — one NY day too far. The
    // shift must anchor NY day Mar 7 + 1 = Mar 8.
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'active', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-03-08T04:30:00Z', due_date: '2026-03-16' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-03-15',
      newDueDate: '2026-03-16',
    });
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.anchor_at.toISOString()).toBe('2026-03-08T12:00:00.000Z');
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
    // Stored anchor's NY day Jul 31 + 7 → NY day Aug 7 at noon UTC.
    expect(patch.anchor_at.toISOString()).toBe('2026-08-07T12:00:00.000Z');
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

  it('shifts the anchor for a PAUSED sequence but leaves next_touch_at for its release path', async () => {
    // Release paths (resumeSequence / releaseFromAutopayHold) re-arm the
    // CURRENT step themselves, but fireStep progression computes later steps
    // from anchor_at — a stale anchor would burst them (codex r3).
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'paused', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-07-15',
      newDueDate: '2026-08-14',
    });
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.anchor_at.toISOString()).toBe('2026-07-31T12:00:00.000Z');
    expect('next_touch_at' in patch).toBe(false);
  });

  it('shifts the anchor for an AUTOPAY-HELD sequence the same way', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'autopay_hold', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-07-15',
      newDueDate: '2026-08-14',
    });
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.anchor_at.toISOString()).toBe('2026-07-31T12:00:00.000Z');
    expect('next_touch_at' in patch).toBe(false);
  });

  it('leaves terminal sequences (stopped/completed) alone', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'stopped', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z' },
    });
    await rescheduleForInvoiceEdit('inv-1', {
      previousDueDate: '2026-07-15',
      newDueDate: '2026-08-14',
    });
    expect(seqUpdate).not.toHaveBeenCalled();
  });
});

describe('release paths re-arm from the shifted anchor when one exists', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resumeSequence schedules the current step from anchor_at, not the due date', async () => {
    // Sent Jul 1, due date extended +30 → anchor Jul 31. Resuming step 0
    // (d3) must land Aug 3 — not Aug 17 (due_date Aug 14 + 3), which would
    // fork the timeline fireStep progression continues on.
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'paused', step_index: 0, anchor_at: new Date('2026-07-31T15:00:00Z') },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z', due_date: '2026-08-14', created_at: '2026-07-01T15:00:00Z' },
    });
    await resumeSequence('inv-1');
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.status).toBe('active');
    expect(patch.next_touch_at.toISOString()).toBe('2026-08-03T14:00:00.000Z');
  });

  it('resumeSequence keeps the due-date re-arm when no anchor was ever shifted', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'paused', step_index: 0, anchor_at: null },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z', due_date: '2026-07-15', created_at: '2026-07-01T15:00:00Z' },
    });
    await resumeSequence('inv-1');
    const patch = seqUpdate.mock.calls[0][0];
    // Pre-existing release formula: date-only due_date parses as UTC
    // midnight, which is the PRIOR evening in NY — so '2026-07-15' anchors
    // the NY calendar day Jul 14, and d3 lands Jul 17, 10 AM EDT.
    expect(patch.next_touch_at.toISOString()).toBe('2026-07-17T14:00:00.000Z');
  });

  it('releaseFromAutopayHold schedules from anchor_at the same way', async () => {
    const { seqUpdate } = setupDb({
      seq: { id: 'seq-1', status: 'autopay_hold', step_index: 0, anchor_at: new Date('2026-07-31T15:00:00Z') },
      invoice: { id: 'inv-1', status: 'sent', sent_at: '2026-07-01T15:00:00Z', due_date: '2026-08-14', created_at: '2026-07-01T15:00:00Z' },
    });
    await releaseFromAutopayHold('inv-1');
    const patch = seqUpdate.mock.calls[0][0];
    expect(patch.status).toBe('active');
    expect(patch.next_touch_at.toISOString()).toBe('2026-08-03T14:00:00.000Z');
  });
});
