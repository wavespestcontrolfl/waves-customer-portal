// Day 90 follow-up ladder (GATE_DUNNING_LADDER_90, dunning unification,
// owner rulings 2026-09-27): Day 3/10/17/30/60/90 with touches a week or
// more apart, Day 90 the only final notice, and a finished sequence still
// owns its invoice so the late-payment checker never picks it up afterwards.
// Gate off: the legacy Day 3/7/14/30 ladder, byte-identical.
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
// ../config/invoice-followups stays REAL: both cadence tables are the contract.

const db = require('../models/db');
const { runPending } = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`); // 10:00 EDT

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
});

// Each `invoice_followup_sequences as s` read is answered in order: the
// ladder's Day 60/90 revival read, then the reopened-invoice revival read,
// then the send batch.
function setupDb({ joinedReads = [], invoiceAtLock = { status: 'overdue', payer_id: null, scheduled_send_error: null }, legacyLedgerRows = [] }) {
  const reads = [...joinedReads];
  const joined = [];
  const seqUpdates = [];
  const lockReads = [];
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  const route = (table) => {
    if (table === 'invoice_followup_sequences as s') {
      const rows = reads.shift() || [];
      const q = { wheres: [] };
      for (const method of ['join', 'whereNotIn', 'whereIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      joined.push(q);
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const q = { wheres: [] };
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.first = jest.fn(async () => undefined);
      q.update = jest.fn(async (patch) => { seqUpdates.push({ wheres: q.wheres, patch }); return 1; });
      return q;
    }
    if (table === 'invoices') {
      const q = { where: jest.fn(() => q), forUpdate: jest.fn(() => q) };
      q.first = jest.fn(async () => { lockReads.push(true); return invoiceAtLock; });
      return q;
    }
    if (table === 'collections_contact_ledger') {
      const q = { where: jest.fn(() => q), whereRaw: jest.fn(() => q) };
      q.then = (resolve, reject) => Promise.resolve(legacyLedgerRows).then(resolve, reject);
      return q;
    }
    if (table === 'activity_log') {
      // The checker's pre-ledger dedupe record: none by default.
      const q = { where: jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; }), whereRaw: jest.fn(() => q), orWhereRaw: jest.fn(() => q) };
      q.first = jest.fn(async () => undefined);
      return q;
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
  db.mockImplementation(route);
  // The reopened revival re-reads the invoice under its row lock inside a
  // transaction; the same recorder answers through the trx handle.
  db.transaction = jest.fn(async (fn) => fn(route));
  return { joined, seqUpdates, lockReads };
}

const finished = (overrides = {}) => ({
  id: 'seq-reopened', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'completed', step_index: 1,
  anchor_at: null, created_at: tenAmET('2026-01-01'), invoice_sent_at: tenAmET('2026-01-01'),
  invoice_sms_sent_at: null, invoice_created_at: tenAmET('2026-01-01'), ...overrides,
});

describe('reopened-invoice revival once the legacy checker retires', () => {
  test('gate off: no revival read at all', async () => {
    const { joined } = setupDb({ joinedReads: [[]] });
    await runPending();
    expect(joined).toHaveLength(1); // the send batch only
  });

  test('legacy-off without the Day 90 ladder: not retired, no revival read', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    const { joined } = setupDb({ joinedReads: [[]] });
    await runPending();
    expect(joined).toHaveLength(1);
  });

  test('both gates on: a sequence completed at a low step (paid early, sent long ago) on a reopened invoice resumes at that step, RE-ANCHORED to now, without sending', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    const { joined, seqUpdates, lockReads } = setupDb({ joinedReads: [[], [finished()], []] });
    const result = await runPending();
    // ladder revival [4,6), then the reopened revival [0,4), then the batch
    expect(joined[1].wheres).toEqual(expect.arrayContaining([
      ['s.status', 'completed'], ['s.step_index', '>=', 0], ['s.step_index', '<', 4],
    ]));
    expect(joined[1].whereIn).toHaveBeenCalledWith('i.status', ['sent', 'viewed', 'overdue']);
    expect(lockReads).toHaveLength(1); // the invoice was re-read under its lock
    expect(seqUpdates).toHaveLength(1);
    expect(seqUpdates[0].wheres).toEqual([[{ id: 'seq-reopened', status: 'completed', step_index: 1 }]]);
    // Re-anchored to NOW: step 1 (Day 10 on the ladder) lands 10 days after the reopen,
    // never on the exhausted January timeline.
    expect(seqUpdates[0].patch).toMatchObject({ status: 'active', anchor_at: NOW, next_touch_at: tenAmET('2026-08-15') });
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });

  test('a sequence that exhausted the legacy cadence unpaid (step 4) is outside the reopened range and left alone', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    const { seqUpdates } = setupDb({ joinedReads: [[], [], []] });
    await runPending();
    expect(seqUpdates).toHaveLength(0);
  });

  test('a payment that settled the invoice between the select and the update leaves the sequence completed', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    const { seqUpdates, lockReads } = setupDb({
      joinedReads: [[], [finished()], []],
      invoiceAtLock: { status: 'paid', payer_id: null, scheduled_send_error: null },
    });
    await runPending();
    expect(lockReads).toHaveLength(1);
    expect(seqUpdates).toHaveLength(0);
  });

  test('a reopened invoice the legacy checker already contacted is never revived: left for a person, logged', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    const logger = require('../services/logger');
    const { seqUpdates, lockReads } = setupDb({
      joinedReads: [[], [finished()], []],
      legacyLedgerRows: [{ idempotency_key: 'late_payment_checker:inv-1:90:sms', invoice_ids: ['inv-1'] }],
    });
    await runPending();
    expect(lockReads).toHaveLength(0);
    expect(seqUpdates).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('reopened invoice(s) with legacy checker history left for a person to settle: inv-1'));
  });
});
