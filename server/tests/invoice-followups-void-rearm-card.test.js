// Round 9 (PR #6117, Codex P2): the Intelligence Bar card and scheduleForInvoice make ONE decision for a system-void-stopped
// sequence (voidStopRearmDecision). Each outcome the card can name must match what the scheduler then writes.
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
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  // The dunning guards read the withdrawal stamp too (a payer-billed
  // combined-visit invoice keeps payer_id NULL).
  invoiceWithdrawnFromCustomer: (invoice) => /^payer_billed:/.test(String(invoice?.scheduled_send_error || '')),
}));
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

jest.mock('../services/pay-combined', () => ({
  lockCombinedCustomers: jest.fn(async () => undefined),
  isCombinedPiMetadata: jest.fn(() => false),
  paymentIntentOwnsInvoice: jest.fn(() => false),
  clearPaymentIntentStamps: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { scheduleForInvoice, planFollowupSequence, voidStopRearmDecision } = require('../services/invoice-followups');
const effects = require('../services/intelligence-bar/invoice-action-effects');


function voidStoppedSeq(overrides = {}) {
  return {
    id: 'seq-1', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'stopped', stopped_reason: 'invoice_voided',
    stopped_by_admin_id: null, is_autopay_held: false, step_index: 0, anchor_at: new Date().toISOString(),
    paused_reason: null, paused_by_admin_id: null, paused_until: null, ...overrides,
  };
}

function setupDb({ seq, invoice, activePlan = null }) {
  const seqUpdate = jest.fn(() => ({ returning: jest.fn(async () => [{ ...seq, written: true }]) }));
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences') {
      const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => seq), update: seqUpdate };
      return q;
    }
    if (table === 'invoices') {
      const q = { where: jest.fn(() => q), forUpdate: jest.fn(() => q), first: jest.fn(async () => invoice) };
      return q;
    }
    if (table === 'customers') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ id: 'cust-1' })) };
      return q;
    }
    if (table === 'payment_plans') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => activePlan) };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { seqUpdate };
}

const sentInvoice = { id: 'inv-1', status: 'sent', customer_id: 'cust-1', created_at: new Date().toISOString(), sent_at: new Date().toISOString() };

describe('the send card and the scheduler agree on a void-stopped sequence', () => {
  beforeEach(() => { jest.clearAllMocks(); customerOnAutopay.mockResolvedValue(false); });

  // [label, sequence overrides, autopay answer, active plan, card state, scheduler write (null = row left as it is)]
  test.each([
    ['an active payment plan leaves the stopped row alone', {}, false, { id: 'plan-1' }, 'payment_plan', null],
    ['a pause kept through the void comes back PAUSED', { stopped_reason: 'invoice_voided:prev=paused' }, false, null, 'paused', { status: 'paused', next_touch_at: null }],
    ['a pause marker on the row comes back PAUSED', { paused_reason: 'customer asked' }, false, null, 'paused', { status: 'paused', next_touch_at: null }],
    ['a held Auto Pay customer is held again', { is_autopay_held: true }, true, null, 'autopay_hold', { status: 'autopay_hold', is_autopay_held: true, next_touch_at: null }],
    ['otherwise the cadence resumes', {}, false, null, 'rearm', { status: 'active', is_autopay_held: false }],
    ['every step already done completes the row', { step_index: 99 }, false, null, 'completed', { status: 'completed' }],
  ])('%s', async (_label, seqOverrides, onAutopay, activePlan, cardState, written) => {
    const seq = voidStoppedSeq(seqOverrides);
    customerOnAutopay.mockResolvedValue(onAutopay);
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice, activePlan });
    const planned = await planFollowupSequence(sentInvoice, db);
    expect(planned.state).toBe(cardState);

    const row = await scheduleForInvoice('inv-1');
    if (written === null) {
      expect(seqUpdate).not.toHaveBeenCalled();
      expect(row).toBe(seq);
    } else {
      expect(seqUpdate.mock.calls[0][0]).toMatchObject(written);
    }
    // The card line says what the scheduler did, not "re-armed" for all of them.
    const text = effects.FOLLOWUP_STATE_TEXT[cardState];
    expect(text).toEqual(expect.any(String));
    if (cardState === 'rearm') expect(text).toMatch(/resum|re-arm|reminder/i);
    else expect(text).not.toBe(effects.FOLLOWUP_STATE_TEXT.rearm);
    // Reminders start only when the scheduler writes an active (or Auto Pay held) row.
    expect(planned.arms).toBe(['rearm', 'autopay_hold'].includes(cardState));
  });

  test('the autopay re-check that cannot be read keeps the hold, on the card and in the scheduler', async () => {
    const seq = voidStoppedSeq({ is_autopay_held: true });
    customerOnAutopay.mockRejectedValue(new Error('unreadable'));
    setupDb({ seq, invoice: sentInvoice });
    expect((await planFollowupSequence(sentInvoice, db)).state).toBe('autopay_hold');
    const { seqUpdate } = setupDb({ seq, invoice: sentInvoice });
    await scheduleForInvoice('inv-1');
    expect(seqUpdate.mock.calls[0][0]).toMatchObject({ status: 'autopay_hold', is_autopay_held: true });
  });

  test('an admin stop is not a system void stop: the card and the scheduler both leave it', async () => {
    const seq = voidStoppedSeq({ stopped_by_admin_id: 'admin-1' });
    setupDb({ seq, invoice: sentInvoice });
    expect((await planFollowupSequence(sentInvoice, db)).state).toBe('existing:stopped');
  });

  test('the decision is one function: neither caller carries its own copy of the checks', () => {
    const source = require('fs').readFileSync(require.resolve('../services/invoice-followups'), 'utf8');
    expect(source.match(/await voidStopRearmDecision\(existing/g)).toHaveLength(2);
    expect(typeof voidStopRearmDecision).toBe('function');
    const planner = source.slice(source.indexOf('async function planFollowupSequence'));
    expect(planner.slice(0, planner.indexOf('\n}\n'))).not.toMatch(/invoice_voided:prev=paused|paused_reason/);
  });
});
