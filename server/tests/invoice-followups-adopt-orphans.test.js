// Orphan-invoice adoption sweep (GATE_DUNNING_ADOPT_ORPHANS, dunning
// unification PR 3): an invoice sent outside the direct-send path never got
// an invoice_followup_sequences row and was left to the legacy
// late-payment-checker.js alone. Gate off: runPending never looks for
// orphans, byte-identical. Gate on: an eligible orphan gets armed through
// scheduleForInvoice — the exact path a normal send takes — BEFORE the batch
// select, so a stale anchor is caught by the SAME run's stale-touch pass,
// never sent late.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  // Real cents-based math — the amount-due > 0 filter is real production
  // logic, not something this suite should reimplement.
  invoiceAmountDue: (invoice) => {
    const totalCents = Math.round((Number(invoice && invoice.total) || 0) * 100);
    const creditCents = Math.round((Number(invoice && invoice.credit_applied) || 0) * 100);
    return Math.max(0, totalCents - creditCents) / 100;
  },
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
const logger = require('../services/logger');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { runPending, adoptOrphanInvoices } = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`); // 10:00 EDT

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.GATE_DUNNING_ADOPT_ORPHANS;
  delete process.env.GATE_DUNNING_LADDER_90;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_ADOPT_ORPHANS;
  delete process.env.GATE_DUNNING_LADDER_90;
});

// The `invoices as i` orphan-candidate query: records every filter clause so
// tests can assert the selection without needing a real Postgres to prove
// the SQL. `where(fn)` and `whereNotExists(fn)` run the callback against a
// tiny recorder so the withdrawn-exclusion and no-active-plan sub-clauses
// are visible too.
function orphanCandidateQuery(rows) {
  const recorded = {
    whereNulls: [], whereNotIn: null, notExistsCalled: false, withdrawnClause: [], orderByRaw: null,
  };
  const q = {};
  q.leftJoin = jest.fn(() => q);
  q.join = jest.fn(() => q);
  q.whereNull = jest.fn((col) => { recorded.whereNulls.push(col); return q; });
  q.whereNotIn = jest.fn((col, vals) => { recorded.whereNotIn = [col, vals]; return q; });
  q.where = jest.fn((fn) => {
    if (typeof fn === 'function') {
      const b = {
        whereNull: jest.fn((col) => { recorded.withdrawnClause.push(['whereNull', col]); return b; }),
        orWhereNot: jest.fn((col, op, val) => { recorded.withdrawnClause.push(['orWhereNot', col, op, val]); return b; }),
      };
      fn.call(b, b);
    }
    return q;
  });
  q.whereNotExists = jest.fn((fn) => {
    recorded.notExistsCalled = true;
    const b = {
      select: jest.fn(() => b), from: jest.fn(() => b), whereRaw: jest.fn(() => b), andWhere: jest.fn(() => b),
    };
    fn.call(b, b);
    return q;
  });
  q.orderByRaw = jest.fn((expr) => { recorded.orderByRaw = expr; return q; });
  q.select = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return { q, recorded };
}

// Full db router: the orphan-candidate select (`invoices as i`) plus every
// table scheduleForInvoice's new-row path touches (`invoices` pre-lock read
// AND the same table under the transaction — db.transaction runs its
// callback against `db` itself, matching invoice-followups-unvoid-rearm's
// pattern), and (for the runPending integration tests) the batch-select
// reads (`invoice_followup_sequences as s`) plus the plain
// `invoice_followup_sequences` table for the existing-row check, the new
// INSERT, and any stale-skip UPDATE.
function setupFullDb({
  orphanRows = [], previewInvoice = null, customer = null, activePlan = null,
  insertedRow = null, batchReads = [], seqUpdateResult = 1,
} = {}) {
  const orphanQuery = orphanCandidateQuery(orphanRows);
  const batchQueue = [...batchReads];
  const joinedBatch = [];
  const seqUpdates = [];
  const insertCalls = [];
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockImplementation((table) => {
    if (table === 'invoices as i') return orphanQuery.q;
    if (table === 'invoice_followup_sequences as s') {
      const rows = batchQueue.shift() || [];
      const q = { wheres: [] };
      for (const method of ['join', 'whereNotIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      joinedBatch.push(q);
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const qq = { wheres: [] };
      qq.where = jest.fn((...args) => { qq.wheres.push(args); return qq; });
      qq.first = jest.fn(async () => undefined); // no existing row — these are orphans by construction
      qq.update = jest.fn(async (patch) => { seqUpdates.push({ wheres: qq.wheres, patch }); return seqUpdateResult; });
      qq.insert = jest.fn((payload) => {
        insertCalls.push(payload);
        return { returning: jest.fn(async () => (insertedRow ? [insertedRow] : [])) };
      });
      return qq;
    }
    if (table === 'invoices') {
      const qq = { where: jest.fn(() => qq), forUpdate: jest.fn(() => qq), first: jest.fn(async () => previewInvoice) };
      return qq;
    }
    if (table === 'payment_plans') {
      const qq = { where: jest.fn(() => qq), first: jest.fn(async () => activePlan) };
      return qq;
    }
    if (table === 'customers') {
      const qq = { where: jest.fn(() => qq), first: jest.fn(async () => customer) };
      return qq;
    }
    throw new Error(`unexpected table in test: ${table}`);
  });
  return {
    orphanQuery, joinedBatch, seqUpdates, insertCalls,
  };
}

function seqRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    status: 'active',
    step_index: 0,
    touches_sent: 0,
    anchor_at: null,
    created_at: tenAmET('2026-07-29'),
    invoice_sent_at: tenAmET('2026-07-29'),
    invoice_sms_sent_at: null,
    invoice_created_at: tenAmET('2026-07-29'),
    ...overrides,
  };
}

describe('adoptOrphanInvoices selection', () => {
  test('excludes an invoice with a sequence, a draft/terminal status, a payer, a payment plan, or a deleted customer', async () => {
    const { orphanQuery } = setupFullDb({ orphanRows: [] });
    await adoptOrphanInvoices({ dryRun: true });
    // "has a sequence" — the left join's NULL check.
    expect(orphanQuery.recorded.whereNulls).toEqual(expect.arrayContaining(['s.id', 'i.payer_id', 'c.deleted_at']));
    // "draft/terminal" — isSchedulableInvoice's own status list.
    expect(orphanQuery.recorded.whereNotIn[0]).toBe('i.status');
    expect(orphanQuery.recorded.whereNotIn[1]).toEqual(expect.arrayContaining(['draft', 'paid', 'void']));
    // "withdrawn to a payer" (payer_billed: stamp), same shape as runPending's own exclusion.
    expect(orphanQuery.recorded.withdrawnClause).toEqual([
      ['whereNull', 'i.scheduled_send_error'],
      ['orWhereNot', 'i.scheduled_send_error', 'like', 'payer_billed:%'],
    ]);
    // "active payment plan" — same guard scheduleForInvoice applies.
    expect(orphanQuery.recorded.notExistsCalled).toBe(true);
    expect(orphanQuery.q.orderByRaw).toHaveBeenCalledWith(expect.stringContaining('COALESCE'));
  });

  test('dryRun returns only invoices with amount due > 0, oldest-sent metadata included, and writes nothing', async () => {
    const oldSent = tenAmET('2026-06-21'); // 45 days before NOW
    const rows = [
      {
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0',
        sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      },
      {
        // fully credited — amount due is 0, must be excluded.
        invoice_id: 'inv-2', customer_id: 'cust-2', total: '50.00', credit_applied: '50.00',
        sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      },
    ];
    setupFullDb({ orphanRows: rows });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ invoice_id: 'inv-1', customer_id: 'cust-1', amount_due: 150 });
    expect(result.candidates[0].days_since_sent).toBe(45);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('live mode arms an eligible orphan through scheduleForInvoice and logs its id', async () => {
    const oldSent = tenAmET('2026-06-21');
    const previewInvoice = {
      id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent,
    };
    const insertedRow = {
      id: 'seq-new', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: tenAmET('2026-06-24'),
    };
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
      previewInvoice,
      customer: { id: 'cust-1' },
      activePlan: null,
      insertedRow,
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result).toEqual({ adopted: 1, invoiceIds: ['inv-1'] });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('adopted 1 orphan invoice(s): inv-1'));
  });

  test('a fully-credited orphan (amount due 0) is never handed to scheduleForInvoice', async () => {
    const oldSent = tenAmET('2026-06-21');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-2', customer_id: 'cust-2', total: '50.00', credit_applied: '50.00', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
    });
    const result = await adoptOrphanInvoices({ dryRun: false });
    expect(result).toEqual({ adopted: 0, invoiceIds: [] });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('runPending and the orphan sweep', () => {
  test('gate off: runPending never looks for orphans (no invoices-as-i query) and behaves as before', async () => {
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    // 'invoices as i' is deliberately NOT registered — a call to it throws,
    // proving adoption was never invoked when the gate is off.
    setupFullDb({ batchReads: [[row]] });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('gate on: an adopted orphan sent 45 days ago lands on its Day 60 step in the same run, without sending', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = tenAmET('2026-06-21'); // 45 days before NOW (2026-08-05)
    const previewInvoice = {
      id: 'inv-orphan', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-orphan', sent_at: anchor,
    };
    const insertedRow = {
      id: 'seq-orphan', invoice_id: 'inv-orphan', customer_id: 'cust-orphan', status: 'active', step_index: 0, next_touch_at: tenAmET('2026-06-24'),
    };
    // What the SAME run's batch select would now see, now that the row
    // exists: step 0, next_touch_at long past (Day 3 from a 45-day-old anchor).
    const batchRowAfterAdoption = seqRow({
      id: 'seq-orphan',
      invoice_id: 'inv-orphan',
      customer_id: 'cust-orphan',
      step_index: 0,
      next_touch_at: insertedRow.next_touch_at,
      anchor_at: null,
      invoice_sent_at: anchor,
      invoice_sms_sent_at: null,
      invoice_created_at: anchor,
      created_at: anchor,
    });
    const { seqUpdates } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-orphan', customer_id: 'cust-orphan', total: '150.00', credit_applied: '0', sent_at: anchor, sms_sent_at: null, created_at: anchor,
      }],
      previewInvoice,
      customer: { id: 'cust-orphan' },
      activePlan: null,
      insertedRow,
      // Revival read (ladder on, runs before adoption) finds nothing, then
      // the main batch select runs AFTER adoption and picks up the fresh row.
      batchReads: [[], [batchRowAfterAdoption]],
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await runPending();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('adopted 1 orphan invoice(s): inv-orphan'));
    // Never sent — only advanced past the stale Day 3/10/17/30 steps.
    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(seqUpdates).toHaveLength(1);
    expect(seqUpdates[0].patch.status).toBe('active');
    expect(seqUpdates[0].patch.step_index).toBe(4); // d60_reminder
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-20')); // anchor + 60 days
    expect(new Date(seqUpdates[0].patch.next_touch_at).getTime()).toBeGreaterThan(NOW.getTime());
  });
});
