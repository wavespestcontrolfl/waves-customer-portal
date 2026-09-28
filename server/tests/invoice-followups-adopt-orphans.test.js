// Orphan-invoice adoption sweep (GATE_DUNNING_ADOPT_ORPHANS, dunning
// unification PR 3): an invoice sent outside the direct-send path never got
// an invoice_followup_sequences row and was left to the legacy
// late-payment-checker.js alone. Gate off: runPending never looks for
// orphans, byte-identical. Gate on: an eligible orphan gets armed through
// scheduleForInvoice — the exact path a normal send takes — BEFORE the batch
// select, so a stale anchor is caught by the SAME run's stale-touch pass,
// never sent late. The legacy checker (Mon–Fri 10:10 ET) can still be live
// alongside this sweep (Tue–Fri 10:16 ET) during rollout, so adoption also:
// maps a freshly-armed row PAST whatever tier the checker already delivered
// (Codex pre-push P0 A2), never fires a touch in the SAME run it adopted a
// row (P0 A1), skips a candidate the checker still has a pending
// delivered-SMS/failed-email retry episode for (P0 B), and seeds/releases an
// autopay-held row from the customer's own prior ACH-failure history (P0 C).
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
// Fully mocked (never the real module — that avoids pulling in ITS whole
// dependency tree) so adoptOrphanInvoices' lazy require sees a controllable
// recoverPendingEmailEpisode. Default: nothing pending.
jest.mock('../services/late-payment-checker', () => ({ recoverPendingEmailEpisode: jest.fn(async () => null) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { recoverPendingEmailEpisode } = require('../services/late-payment-checker');
const { runPending, adoptOrphanInvoices } = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`); // 10:00 EDT

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  recoverPendingEmailEpisode.mockResolvedValue(null);
  delete process.env.GATE_DUNNING_ADOPT_ORPHANS;
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_ADOPT_ORPHANS;
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_LATE_PAYMENT_CHECKER_OFF;
});

// The `invoices as i` orphan-candidate query: records every filter clause so
// tests can assert the selection without needing a real Postgres to prove
// the SQL. `where(fn)` and `whereNotExists(fn)` run the callback against a
// tiny recorder so the withdrawn-exclusion and no-active-plan sub-clauses
// are visible too.
function orphanCandidateQuery(rows) {
  const recorded = {
    whereNulls: [], whereNotIn: null, whereIn: null, notExistsCalled: false, withdrawnClause: [], orderByRaw: null,
  };
  const q = {};
  q.leftJoin = jest.fn(() => q);
  q.join = jest.fn(() => q);
  q.whereNull = jest.fn((col) => { recorded.whereNulls.push(col); return q; });
  q.whereNotIn = jest.fn((col, vals) => { recorded.whereNotIn = [col, vals]; return q; });
  q.whereIn = jest.fn((col, vals) => { recorded.whereIn = [col, vals]; return q; });
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
// pattern), plus the legacy-tier-mapping and autopay-history reads (A2/C:
// `collections_contact_ledger`, `ach_failure_log`), and (for the runPending
// integration tests) the batch-select reads (`invoice_followup_sequences as
// s`) plus the plain `invoice_followup_sequences` table.
//
// The plain `invoice_followup_sequences` table is a light stateful stand-in
// so releaseFromAutopayHold's OWN independent re-read (a second
// `.where({invoice_id}).first()`, after the insert) sees the row: the FIRST
// call for a given invoice_id (scheduleForInvoice's pre-insert existing-row
// check) returns undefined, every call after returns `insertedRow`; a
// `.where({id}).first()` for `insertedRow.id` always returns it too.
function setupFullDb({
  orphanRows = [], previewInvoice = null, customer = null, activePlan = null,
  insertedRow = null, batchReads = [], seqUpdateResult = 1,
  legacyLedgerRows = [], achFailureCount = 0,
} = {}) {
  const orphanQuery = orphanCandidateQuery(orphanRows);
  const batchQueue = [...batchReads];
  const joinedBatch = [];
  const seqUpdates = [];
  const insertCalls = [];
  const seenInvoiceIds = new Set();
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockImplementation((table) => {
    if (table === 'invoices as i') return orphanQuery.q;
    if (table === 'invoice_followup_sequences as s') {
      const rows = batchQueue.shift() || [];
      const q = { wheres: [] };
      for (const method of ['join', 'whereNotIn', 'whereIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      joinedBatch.push(q);
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const qq = { wheres: [] };
      qq.where = jest.fn((cond) => { qq.wheres.push(cond); return qq; });
      qq.first = jest.fn(async () => {
        const cond = qq.wheres[qq.wheres.length - 1] || {};
        if (cond.invoice_id && insertedRow && cond.invoice_id === insertedRow.invoice_id) {
          if (seenInvoiceIds.has(cond.invoice_id)) return insertedRow;
          seenInvoiceIds.add(cond.invoice_id);
          return undefined;
        }
        if (cond.id && insertedRow && cond.id === insertedRow.id) return insertedRow;
        return undefined;
      });
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
    if (table === 'collections_contact_ledger') {
      const qq = { where: jest.fn(() => qq), whereRaw: jest.fn(() => qq) };
      qq.then = (resolve, reject) => Promise.resolve(legacyLedgerRows).then(resolve, reject);
      return qq;
    }
    if (table === 'ach_failure_log') {
      const qq = { where: jest.fn(() => qq), count: jest.fn(() => qq), first: jest.fn(async () => ({ cnt: achFailureCount })) };
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
    // Delivered statuses ONLY (never 'scheduled'/'sending' — not yet
    // actually delivered to the customer) — the same whitelist
    // late-payment-checker.js's own candidate query uses.
    expect(orphanQuery.recorded.whereIn).toEqual(['i.status', ['sent', 'viewed', 'overdue']]);
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
    expect(result.skipped).toEqual([]);
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

    expect(result).toEqual({ adopted: 1, invoiceIds: ['inv-1'], skipped: [] });
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
    expect(result).toEqual({ adopted: 0, invoiceIds: [], skipped: [] });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// Codex pre-push P0 (A2): the legacy checker's own delivered tier maps onto
// the ladder so a freshly-adopted row never repeats a reminder already sent.
describe('adoptOrphanInvoices maps past the legacy checker\'s delivered tier', () => {
  test('a delivered 30-day tier (>24h ago) maps straight to the Day 60 step, no send', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const oldSent = tenAmET('2026-06-21');
    const previewInvoice = {
      id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent,
    };
    const insertedRow = {
      id: 'seq-new', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: tenAmET('2026-06-24'),
    };
    const { seqUpdates } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
      previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow,
      legacyLedgerRows: [{
        idempotency_key: 'late_payment_checker:inv-1:30:sms',
        metadata: { delivered: true },
        occurred_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
        invoice_ids: ['inv-1'],
      }],
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result.adopted).toBe(1);
    const mapUpdate = seqUpdates.find((u) => u.patch.step_index === 4);
    expect(mapUpdate).toBeTruthy();
    expect(mapUpdate.wheres).toEqual([{ id: 'seq-new', step_index: 0, status: 'active' }]);
    expect(mapUpdate.patch.status).toBe('active');
    expect(mapUpdate.patch.next_touch_at).toEqual(tenAmET('2026-08-20')); // anchor + 60 days
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('mapped past legacy tier 30d to step 4'));
  });

  test('a delivery inside the last 7 days delays the landing step to a week after it — never skips a further step', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const oldSent = tenAmET('2026-06-01'); // Day 60 by the anchor = 2026-07-31, already past
    const previewInvoice = {
      id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent,
    };
    const insertedRow = {
      id: 'seq-new', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: tenAmET('2026-06-04'),
    };
    const { seqUpdates } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
      previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow,
      legacyLedgerRows: [{
        idempotency_key: 'late_payment_checker:inv-1:30:sms',
        metadata: { delivered: true },
        occurred_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
        invoice_ids: ['inv-1'],
      }],
    });
    customerOnAutopay.mockResolvedValue(false);

    await adoptOrphanInvoices({ dryRun: false });

    const mapUpdate = seqUpdates.find((u) => u.patch.step_index === 4); // the tier-30 target (Day 60), not a step further
    expect(mapUpdate).toBeTruthy();
    expect(seqUpdates.find((u) => u.patch.step_index === 5)).toBeUndefined();
    // Day 60 by the anchor (2026-07-31) is earlier than 7 days after the
    // legacy delivery 2h ago (2026-08-05), so the landing step is floored to
    // 2026-08-12 10:00 NY instead of being skipped to Day 90.
    expect(mapUpdate.patch.next_touch_at).toEqual(tenAmET('2026-08-12'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('first touch delayed to'));
  });

  test('a non-delivered (send_failed) ledger row is ignored — no mapping', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const oldSent = tenAmET('2026-06-21');
    const previewInvoice = {
      id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent,
    };
    const insertedRow = {
      id: 'seq-new', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: tenAmET('2026-06-24'),
    };
    const { seqUpdates } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
      previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow,
      legacyLedgerRows: [{
        idempotency_key: 'late_payment_checker:inv-1:30:sms',
        metadata: { send_failed: true },
        occurred_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000),
        invoice_ids: ['inv-1'],
      }],
    });
    customerOnAutopay.mockResolvedValue(false);

    await adoptOrphanInvoices({ dryRun: false });

    expect(seqUpdates.filter((u) => u.wheres[0]?.id === 'seq-new')).toHaveLength(0);
  });
});

// Codex pre-push P0 (B).
describe('adoptOrphanInvoices holds a candidate with a pending legacy email episode', () => {
  test('live mode: skipped, not scheduled, reason recorded', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const oldSent = tenAmET('2026-06-21');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
    });
    recoverPendingEmailEpisode.mockResolvedValueOnce({ tierDays: 7, ledgerIds: ['led-1'], emailLedgerId: 'led-1' });

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result).toEqual({ adopted: 0, invoiceIds: [], skipped: [{ invoice_id: 'inv-1', reason: 'pending_legacy_email' }] });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('dryRun: excluded from candidates, reported in skipped', async () => {
    const oldSent = tenAmET('2026-06-21');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
    });
    recoverPendingEmailEpisode.mockResolvedValueOnce({ tierDays: 7, ledgerIds: [], emailLedgerId: 'led-1' });

    const result = await adoptOrphanInvoices({ dryRun: true });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toEqual([{ invoice_id: 'inv-1', reason: 'pending_legacy_email' }]);
  });

  test('once the episode resolves (recoverPendingEmailEpisode returns null again), the invoice is adopted', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
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
      insertedRow,
    });
    // Default mock (beforeEach) already resolves null — the "no episode" state.
    customerOnAutopay.mockResolvedValue(false);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result.adopted).toBe(1);
    expect(result.invoiceIds).toEqual(['inv-1']);
  });

  test('an unreadable episode check fails closed — skipped, not adopted', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const oldSent = tenAmET('2026-06-21');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
    });
    recoverPendingEmailEpisode.mockResolvedValueOnce({ unavailable: true });

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result.adopted).toBe(0);
    expect(result.skipped).toEqual([{ invoice_id: 'inv-1', reason: 'pending_legacy_email' }]);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// Codex pre-push P0 (C).
describe('adoptOrphanInvoices seeds/releases an autopay-held row from prior ACH failure history', () => {
  function autopayCandidate(overrides = {}) {
    const oldSent = tenAmET('2026-06-21');
    return {
      oldSent,
      previewInvoice: {
        id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent,
      },
      insertedRow: {
        id: 'seq-new', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'autopay_hold', step_index: 0, next_touch_at: null, is_autopay_held: true, autopay_failures_observed: 0,
      },
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent,
      }],
      ...overrides,
    };
  }

  test('a customer already at the failure threshold is released immediately, at the correct (tier-mapped) step', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const c = autopayCandidate();
    const { seqUpdates } = setupFullDb({
      orphanRows: c.orphanRows,
      previewInvoice: c.previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow: c.insertedRow,
      achFailureCount: 3, // config.autopayFailureThreshold
    });
    customerOnAutopay.mockResolvedValue(true);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result.adopted).toBe(1);
    const releaseUpdate = seqUpdates.find((u) => u.patch.status === 'active');
    expect(releaseUpdate).toBeTruthy();
    expect(releaseUpdate.wheres).toEqual([{ id: 'seq-new', status: 'autopay_hold' }]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('released from autopay_hold — customer already had 3 unresolved ACH failure(s)'),
    );
  });

  test('a customer with SOME prior failures below threshold has the counter seeded, still held', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const c = autopayCandidate();
    const { seqUpdates } = setupFullDb({
      orphanRows: c.orphanRows,
      previewInvoice: c.previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow: c.insertedRow,
      achFailureCount: 1,
    });
    customerOnAutopay.mockResolvedValue(true);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result.adopted).toBe(1);
    const seedUpdate = seqUpdates.find((u) => u.patch.autopay_failures_observed === 1);
    expect(seedUpdate).toBeTruthy();
    expect(seedUpdate.wheres).toEqual([{ id: 'seq-new', status: 'autopay_hold' }]);
    expect(seedUpdate.patch.status).toBeUndefined(); // still held — no status flip
  });

  test('no prior failures — row is left exactly as scheduleForInvoice created it (regression)', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const c = autopayCandidate();
    const { seqUpdates } = setupFullDb({
      orphanRows: c.orphanRows,
      previewInvoice: c.previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow: c.insertedRow,
      achFailureCount: 0,
    });
    customerOnAutopay.mockResolvedValue(true);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result.adopted).toBe(1);
    expect(seqUpdates.filter((u) => u.wheres[0]?.id === 'seq-new')).toHaveLength(0);
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

  // Codex pre-push P0 (A1) / Fable pre-push P2 (G): the adopted-this-run
  // suppression must hold even when the skip-forward LANDS the row on a
  // step genuinely due today — the send still waits for the next run.
  test('an orphan whose skip-forward lands on a step due today is NOT fired this run — fires next run', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const anchor = tenAmET('2026-07-06'); // 30 days before NOW
    const previewInvoice = {
      id: 'inv-orphan', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-orphan', sent_at: anchor,
    };
    const insertedRow = {
      id: 'seq-orphan', invoice_id: 'inv-orphan', customer_id: 'cust-orphan', status: 'active', step_index: 0, next_touch_at: tenAmET('2026-07-09'),
    };
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
      insertedRow,
      // Gate off ladder / checker-retired revival: this is the only 's' read.
      batchReads: [[batchRowAfterAdoption]],
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await runPending();

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('invoice inv-orphan adopted this run — first touch deferred to 2026-08-06T14:00:00.000Z'),
    );
    // The skip-forward pass still advances the timeline correctly — Day 30
    // (legacy cadence, gate off) lands exactly today — then the landing step
    // is re-dated to the next run (Thu 2026-08-06 10:00 NY) under a guard on
    // the just-persisted step/due, so the next tick sends it fresh.
    expect(seqUpdates).toHaveLength(2);
    expect(seqUpdates[0].patch.step_index).toBe(3);
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-05'));
    expect(seqUpdates[0].patch.status).toBe('active');
    expect(seqUpdates[1].wheres).toEqual([{ id: 'seq-orphan', status: 'active', step_index: 3, next_touch_at: tenAmET('2026-08-05') }]);
    expect(seqUpdates[1].patch.next_touch_at).toEqual(tenAmET('2026-08-06'));
  });
});

// Codex pre-push r1 P1 (retained from the prior round) + P0 (D): a sequence
// that finished BEFORE the legacy Day 30 end (paid after only its early
// touches fired) has always relied on the legacy checker as its ONLY
// fallback if the invoice is later reopened (hasActiveSequence deliberately
// excludes a low-step 'completed' row from "owned"). GATE_LATE_PAYMENT_CHECKER_OFF
// must not remove that coverage, and the revival must RE-ANCHOR to the
// reopen (not the original, possibly Day-90+-stale send) or a late reopen
// would stale-complete without sending and be re-selected forever.
describe('runPending revives a reopened low-step sequence once the legacy checker retires', () => {
  test('gate off (checker still running): runPending never looks for a reopened sequence', async () => {
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    // No revival read registered at all — a call to it throws, proving the
    // revival never ran while the checker is still the fallback.
    setupFullDb({ batchReads: [[row]] });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('gate on: a sequence completed at step 1 (paid early, sent long ago) on a reopened invoice resumes at step 1, RE-ANCHORED to the reopen, without sending', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    const oldAnchor = tenAmET('2026-01-01'); // long past its own Day 90 — an unanchored revival would stale-complete instead of firing
    const finished = seqRow({
      id: 'seq-reopened', invoice_id: 'inv-reopened', customer_id: 'cust-reopened', status: 'completed', step_index: 1, anchor_at: oldAnchor, invoice_sent_at: oldAnchor,
    });
    const { joinedBatch, seqUpdates } = setupFullDb({
      // Revival read (checker retired, runs before the main batch select) finds the reopened sequence.
      batchReads: [[finished], []],
    });

    const result = await runPending();

    // The revival read targets [0, legacyCount) — the band the ladder's own
    // Day 60/90 revival does NOT cover, and (structurally) excludes a
    // step_index === legacyCount "ran out of steps, never paid" row too —
    // that row can never match `< 4` and so can never loop through here.
    expect(joinedBatch[0].wheres).toEqual(expect.arrayContaining([
      ['s.status', 'completed'], ['s.step_index', '>=', 0], ['s.step_index', '<', 4],
    ]));
    expect(seqUpdates).toHaveLength(1);
    expect(seqUpdates[0].wheres).toEqual([{ id: 'seq-reopened', status: 'completed', step_index: 1 }]);
    expect(seqUpdates[0].patch.status).toBe('active');
    // Re-anchored to NOW (the reopen), never the stale 2026-01-01 send —
    // Day 7 off NOW (2026-08-05) is 2026-08-12, always safely in the future.
    expect(seqUpdates[0].patch.anchor_at).toEqual(NOW);
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-12'));
    expect(new Date(seqUpdates[0].patch.next_touch_at).getTime()).toBeGreaterThan(NOW.getTime());
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('retired checker: 1 reopened invoice(s) resumed on their follow-up sequence (re-anchored to the reopen)'),
    );
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });
});
