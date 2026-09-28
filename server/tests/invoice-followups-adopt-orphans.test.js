// Orphan-invoice adoption sweep (GATE_DUNNING_ADOPT_ORPHANS, dunning
// unification PR 3): an invoice sent outside the direct-send path never got
// an invoice_followup_sequences row and was left to the legacy
// late-payment-checker.js alone.
//
// Design (post Codex r1 rewrite): NO seeding pass and no post-insert release
// — a candidate is either armed once, atomically, or left on the hand list.
// `selectAdoptionCandidates` (shared by the dry-run script and the live
// sweep) walks delivered, homeowner-billed, no-active-plan, no-existing-row
// invoices with a balance and buckets each one as a candidate or a skip
// reason: has_legacy_history (a collections_contact_ledger row OR the
// checker's own activity_log 'late_payment_reminder' dedupe row, matched by
// metadata.invoiceId or an invoiceKey prefix), legacy_history_unreadable,
// past_final_step (every ladder day has passed — adoptionLanding has
// nowhere to land it), ach_failure_history (ANY unresolved ACH failure,
// independent of autopay standing), ach_history_unreadable. A survivor is
// hand ed to `scheduleForInvoice(id, { adoption: true })` — the exact path a
// normal invoice send takes — which computes its OWN landing under the
// invoice lock: EVERY adoption takes the 'ach.escalation' advisory lock and
// is left for a person on any unresolved failure (r2: before the autopay
// read, since failures can move a customer off autopay); otherwise an
// autopay customer lands
// an autopay_hold row (next_touch_at null) at `adoptionLanding`'s step; a
// non-autopay customer lands an active row directly at the first step whose
// send day is not stale, re-dated to the next send-window day if that step
// is due at/before now — so an adopted row's next_touch_at is NEVER in the
// past and NEVER sent in the run that adopted it, by construction (no
// separate deferral write, unlike the retired design).
//
// The live sweep runs candidate selection AND scheduling inside
// runExclusive('late-payment-check', …) (server/utils/cron-lock.js, mocked
// below) — the legacy checker's own lease — refusing outright
// (refused: 'checker_lock_held') rather than racing an in-flight checker
// run's history writes.
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
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));
// adoptOrphanInvoices lazy-requires this for the live sweep's lock. Default:
// runs the callback for real (the same as an uncontended lock in
// production); individual tests override with mockResolvedValueOnce to
// simulate a refusal.
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((jobName, fn) => fn()) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { runExclusive } = require('../utils/cron-lock');
const { runPending, adoptOrphanInvoices, scheduleForInvoice } = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`); // 10:00 EDT

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
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

// The `activity_log` 'late_payment_reminder' dedupe lookup legacyCheckerContacted
// falls back to when the collections_contact_ledger has no row: records the
// action filter and the whereRaw/orWhereRaw pair (metadata.invoiceId, then the
// invoiceKey prefix IN (...)) so tests can assert the exact refs probed.
function activityLogQuery(row) {
  const recorded = { where: null, whereRaw: [] };
  const q = {};
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') {
      const b = {
        whereRaw: jest.fn((sql, bindings) => { recorded.whereRaw.push([sql, bindings]); return b; }),
        orWhereRaw: jest.fn((sql, bindings) => { recorded.whereRaw.push([sql, bindings]); return b; }),
      };
      arg.call(b, b);
    } else {
      recorded.where = arg;
    }
    return q;
  });
  q.first = jest.fn(async () => row || undefined);
  return { q, recorded };
}

// Full db router: the orphan-candidate select (`invoices as i`), the
// activity_log dedupe fallback, every table scheduleForInvoice's new-row
// path touches (`invoices` pre-lock read AND the same table under the
// transaction — db.transaction runs its callback against `db` itself,
// matching invoice-followups-unvoid-rearm's pattern), plus the
// legacy-history and ACH-history reads (`collections_contact_ledger`,
// `ach_failure_log`), and (for the runPending integration tests) the
// revival + batch-select reads (`invoice_followup_sequences as s`).
//
// `existingRow`, when given, makes the pre-INSERT existing-row check inside
// scheduleForInvoice see a row already there (adoption must leave it alone).
// Otherwise the plain `invoice_followup_sequences` table is a light
// stateful stand-in: the FIRST `.where({invoice_id}).first()` returns
// undefined (no row yet), every call after returns `insertedRow`.
function setupFullDb({
  orphanRows = [], previewInvoice = null, customer = null, activePlan = null,
  existingRow = null, insertedRow = null, batchReads = [], seqUpdateResult = 1,
  legacyLedgerRows = [], legacyLedgerError = null, activityLogRow = null,
  achFailureCount = 0, achReadError = null,
} = {}) {
  const orphanQuery = orphanCandidateQuery(orphanRows);
  const activityLog = activityLogQuery(activityLogRow);
  const batchQueue = [...batchReads];
  const seqUpdates = [];
  const insertCalls = [];
  const seenInvoiceIds = new Set();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockImplementation((table) => {
    if (table === 'invoices as i') return orphanQuery.q;
    if (table === 'activity_log') return activityLog.q;
    if (table === 'invoice_followup_sequences as s') {
      const rows = batchQueue.shift() || [];
      const q = { wheres: [] };
      for (const method of ['join', 'whereNotIn', 'whereIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const qq = { wheres: [] };
      qq.where = jest.fn((cond) => { qq.wheres.push(cond); return qq; });
      qq.first = jest.fn(async () => {
        const cond = qq.wheres[qq.wheres.length - 1] || {};
        if (cond.invoice_id) {
          if (existingRow && cond.invoice_id === existingRow.invoice_id) return existingRow;
          if (insertedRow && cond.invoice_id === insertedRow.invoice_id) {
            if (seenInvoiceIds.has(cond.invoice_id)) return insertedRow;
            seenInvoiceIds.add(cond.invoice_id);
            return undefined;
          }
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
      const qq = { whereRaw: jest.fn(() => qq) };
      qq.where = jest.fn(() => qq);
      qq.then = (resolve, reject) => (legacyLedgerError ? Promise.reject(legacyLedgerError) : Promise.resolve(legacyLedgerRows)).then(resolve, reject);
      return qq;
    }
    if (table === 'ach_failure_log') {
      const qq = { where: jest.fn(() => qq), count: jest.fn(() => qq), first: jest.fn(async () => { if (achReadError) throw achReadError; return { cnt: achFailureCount }; }) };
      return qq;
    }
    throw new Error(`unexpected table in test: ${table}`);
  });
  return {
    orphanQuery, activityLogRecorded: activityLog.recorded, seqUpdates, insertCalls,
  };
}

function seqRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    status: 'active',
    step_index: 0,
    anchor_at: null,
    created_at: tenAmET('2026-07-29'),
    invoice_sent_at: tenAmET('2026-07-29'),
    invoice_sms_sent_at: null,
    invoice_created_at: tenAmET('2026-07-29'),
    ...overrides,
  };
}

describe('selectAdoptionCandidates (dry run)', () => {
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

  test('returns only invoices with amount due > 0, oldest-sent metadata included, and writes nothing', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true'; // Day 60 still ahead at 45 days — the fixture below is about the $ filter, not landing
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

  test('skips has_legacy_history when collections_contact_ledger has a row for the invoice', async () => {
    const recentSent = tenAmET('2026-08-04'); // 1 day old — Day 3 not yet due, so this isn't a landing skip
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', invoice_number: 'INV-1001', customer_id: 'cust-1', total: '150.00', credit_applied: '0',
        sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
      legacyLedgerRows: [{ idempotency_key: 'late_payment_checker:inv-1:30:sms', metadata: { delivered: true }, invoice_ids: ['inv-1'] }],
    });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result).toEqual({ candidates: [], skipped: [{ invoice_id: 'inv-1', customer_id: 'cust-1', reason: 'has_legacy_history' }] });
  });

  test('skips has_legacy_history via the checker\'s own activity_log dedupe row when the ledger has none, matched by invoiceId then the invoiceKey prefix', async () => {
    const recentSent = tenAmET('2026-08-04');
    const { activityLogRecorded } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', invoice_number: 'INV-1001', customer_id: 'cust-1', total: '150.00', credit_applied: '0',
        sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
      legacyLedgerRows: [],
      activityLogRow: { id: 'act-1' },
    });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result).toEqual({ candidates: [], skipped: [{ invoice_id: 'inv-1', customer_id: 'cust-1', reason: 'has_legacy_history' }] });
    expect(activityLogRecorded.where).toEqual({ action: 'late_payment_reminder' });
    expect(activityLogRecorded.whereRaw[0]).toEqual(["metadata->>'invoiceId' = ?", ['inv-1']]);
    expect(activityLogRecorded.whereRaw[1][0]).toContain("split_part(metadata->>'invoiceKey', '|', 1) IN");
    expect(activityLogRecorded.whereRaw[1][1]).toEqual(['inv-1', 'INV-1001']);
  });

  test('an unreadable legacy history (ledger read throws) fails closed as legacy_history_unreadable', async () => {
    const recentSent = tenAmET('2026-08-04');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
      legacyLedgerError: new Error('ledger unavailable'),
    });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result).toEqual({ candidates: [], skipped: [{ invoice_id: 'inv-1', customer_id: 'cust-1', reason: 'legacy_history_unreadable' }] });
  });

  test('skips past_final_step when every ladder day has already passed — before any ACH read', async () => {
    const veryOldSent = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000); // past the legacy Day 30 end (gate off)
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: veryOldSent, sms_sent_at: null, created_at: veryOldSent,
      }],
      // Proves ordering: if the ACH table were reached, this throw would
      // surface as ach_history_unreadable instead.
      achReadError: new Error('should never be reached — past_final_step short-circuits first'),
    });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result).toEqual({ candidates: [], skipped: [{ invoice_id: 'inv-1', customer_id: 'cust-1', reason: 'past_final_step' }] });
  });

  test('skips ach_failure_history on ANY unresolved ACH failure, independent of autopay standing', async () => {
    const recentSent = tenAmET('2026-08-04');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
      achFailureCount: 1,
    });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result).toEqual({ candidates: [], skipped: [{ invoice_id: 'inv-1', customer_id: 'cust-1', reason: 'ach_failure_history' }] });
    // selectAdoptionCandidates never consults autopay standing — that's scheduleForInvoice's job.
    expect(customerOnAutopay).not.toHaveBeenCalled();
  });

  test('skips ach_history_unreadable when the ACH log read throws, retried next sweep', async () => {
    const recentSent = tenAmET('2026-08-04');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
      achReadError: new Error('ach log unavailable'),
    });
    const result = await adoptOrphanInvoices({ dryRun: true });
    expect(result).toEqual({ candidates: [], skipped: [{ invoice_id: 'inv-1', customer_id: 'cust-1', reason: 'ach_history_unreadable' }] });
  });
});

describe('scheduleForInvoice(id, { adoption: true })', () => {
  test('fails closed when the autopay read throws: the transaction rolls back, no row is inserted', async () => {
    const anchor = tenAmET('2026-08-04');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' } });
    customerOnAutopay.mockRejectedValue(new Error('payment method read failed'));

    await expect(scheduleForInvoice('inv-1', { adoption: true })).rejects.toThrow('payment method read failed');

    expect(insertCalls).toHaveLength(0);
    expect(customerOnAutopay).toHaveBeenCalledWith({ id: 'cust-1' }, expect.objectContaining({ failClosed: true }));
  });

  test('an autopay customer with an unresolved ACH failure is left for a person: advisory lock taken, no row inserted', async () => {
    const anchor = tenAmET('2026-08-04');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, achFailureCount: 1 });
    customerOnAutopay.mockResolvedValue(true);

    const result = await scheduleForInvoice('inv-1', { adoption: true });

    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
    expect(db.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['ach.escalation', 'cust-1'],
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('adoption left invoice inv-1 for a person: customer has unresolved ACH failures'));
  });

  test('a customer failures already moved OFF autopay is still left for a person: the lock and count run before the autopay read (Codex r2)', async () => {
    const anchor = tenAmET('2026-08-04');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, achFailureCount: 2 });
    customerOnAutopay.mockResolvedValue(false);

    const result = await scheduleForInvoice('inv-1', { adoption: true });

    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
    expect(db.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['ach.escalation', 'cust-1'],
    );
    expect(customerOnAutopay).not.toHaveBeenCalled();
  });

  test('an autopay customer with no unresolved ACH failures lands an autopay_hold row at the landing step, next_touch_at null', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = tenAmET('2026-06-21'); // 45 days before NOW -> Day 60 (index 4) under the ladder
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const insertedRow = { id: 'seq-1', invoice_id: 'inv-1' };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, insertedRow, achFailureCount: 0 });
    customerOnAutopay.mockResolvedValue(true);

    await scheduleForInvoice('inv-1', { adoption: true });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      invoice_id: 'inv-1', customer_id: 'cust-1', status: 'autopay_hold', step_index: 4, next_touch_at: null, is_autopay_held: true,
    });
  });

  test('an invoice that already gained a row is left alone: no insert, autopay never read', async () => {
    const anchor = tenAmET('2026-08-04');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, existingRow: { invoice_id: 'inv-1', id: 'seq-existing' } });

    const result = await scheduleForInvoice('inv-1', { adoption: true });

    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
    expect(customerOnAutopay).not.toHaveBeenCalled();
  });

  test('landing (ladder on): sent 45 days ago lands directly on the Day 60 step', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = tenAmET('2026-06-21');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const insertedRow = { id: 'seq-1', invoice_id: 'inv-1' };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, insertedRow });
    customerOnAutopay.mockResolvedValue(false);

    await scheduleForInvoice('inv-1', { adoption: true });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ status: 'active', step_index: 4, is_autopay_held: false });
    expect(insertCalls[0].next_touch_at).toEqual(tenAmET('2026-08-20'));
  });

  test('landing (ladder off): sent 45 days ago has passed every legacy step — left for a person', async () => {
    const anchor = tenAmET('2026-06-21');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' } });
    customerOnAutopay.mockResolvedValue(false);

    const result = await scheduleForInvoice('inv-1', { adoption: true });

    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('adoption left invoice inv-1 for a person: every ladder step has passed'));
  });

  test('landing (ladder on): a step due exactly today re-dates to tomorrow 10:00 NY, never landing already due', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = tenAmET('2026-07-06'); // Day 30 lands exactly on NOW's date on either cadence
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const insertedRow = { id: 'seq-1', invoice_id: 'inv-1' };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, insertedRow });
    customerOnAutopay.mockResolvedValue(false);

    await scheduleForInvoice('inv-1', { adoption: true });

    expect(insertCalls[0]).toMatchObject({ status: 'active', step_index: 3 });
    expect(insertCalls[0].next_touch_at).toEqual(tenAmET('2026-08-06'));
  });

  test('landing (ladder off): a step due exactly today re-dates to tomorrow 10:00 NY, same as the ladder', async () => {
    const anchor = tenAmET('2026-07-06');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const insertedRow = { id: 'seq-1', invoice_id: 'inv-1' };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' }, insertedRow });
    customerOnAutopay.mockResolvedValue(false);

    await scheduleForInvoice('inv-1', { adoption: true });

    expect(insertCalls[0]).toMatchObject({ status: 'active', step_index: 3 });
    expect(insertCalls[0].next_touch_at).toEqual(tenAmET('2026-08-06'));
  });

  test('landing (ladder on): sent 200 days ago has passed even Day 90 — left for a person', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000);
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: anchor };
    const { insertCalls } = setupFullDb({ previewInvoice, customer: { id: 'cust-1' } });
    customerOnAutopay.mockResolvedValue(false);

    const result = await scheduleForInvoice('inv-1', { adoption: true });

    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
  });
});

describe('adoptOrphanInvoices: live sweep locking', () => {
  test('refused before the checker retires: no lock taken, nothing written', async () => {
    const recentSent = tenAmET('2026-08-04');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
    });

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result).toEqual({ adopted: 0, invoiceIds: [], skipped: [], refused: 'checker_running' });
    expect(runExclusive).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('adoption refused: GATE_LATE_PAYMENT_CHECKER_OFF is not live'));
  });

  test('runs candidate selection and scheduling under runExclusive("late-payment-check", …, { recordHealth: false, waitForSlot: false })', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    setupFullDb({ orphanRows: [] });

    await adoptOrphanInvoices({ dryRun: false });

    expect(runExclusive).toHaveBeenCalledWith('late-payment-check', expect.any(Function), { recordHealth: false, waitForSlot: false });
  });

  test('a lock refused as lease_held is reported refused: checker_lock_held, and candidate selection never runs', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    const recentSent = tenAmET('2026-08-04');
    setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: recentSent, sms_sent_at: null, created_at: recentSent,
      }],
    });

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(result).toEqual({ adopted: 0, invoiceIds: [], skipped: [], refused: 'checker_lock_held' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("adoption refused this run: the late-payment checker's lock is held (lease_held)"));
    // Candidate selection (selectAdoptionCandidates -> `invoices as i`) runs
    // INSIDE the lock callback — a refused lock never reaches it.
    expect(db.mock.calls.some(([table]) => table === 'invoices as i')).toBe(false);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a genuinely eligible orphan is armed for real under an acquired lock', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const oldSent = tenAmET('2026-06-21');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent };
    const insertedRow = { id: 'seq-new', invoice_id: 'inv-1' };
    const { insertCalls } = setupFullDb({
      orphanRows: [{ invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent }],
      previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow,
    });
    customerOnAutopay.mockResolvedValue(false);

    await adoptOrphanInvoices({ dryRun: false });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active', step_index: 4 });
  });

  test('a candidate with legacy checker history is filtered inside the lock and never reaches scheduleForInvoice', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const oldSent = tenAmET('2026-06-21');
    setupFullDb({
      orphanRows: [{ invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent }],
      legacyLedgerRows: [{ idempotency_key: 'late_payment_checker:inv-1:30:sms', metadata: {}, invoice_ids: ['inv-1'] }],
    });

    await adoptOrphanInvoices({ dryRun: false });

    expect(db.transaction).not.toHaveBeenCalled();
  });

  // runExclusive's refusal is { skipped: true, reason }; the body's own
  // result carries a skipped ARRAY (truthy even when empty), so a success
  // must never be read as a refusal.
  test('a successful lock run reports the adopted row, never a refusal', async () => {
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const oldSent = tenAmET('2026-06-21');
    const previewInvoice = { id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-1', sent_at: oldSent };
    const insertedRow = { id: 'seq-new', invoice_id: 'inv-1' };
    const { insertCalls } = setupFullDb({
      orphanRows: [{ invoice_id: 'inv-1', customer_id: 'cust-1', total: '150.00', credit_applied: '0', sent_at: oldSent, sms_sent_at: null, created_at: oldSent }],
      previewInvoice,
      customer: { id: 'cust-1' },
      insertedRow,
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await adoptOrphanInvoices({ dryRun: false });

    expect(insertCalls).toHaveLength(1); // the row really was written
    expect(result).toEqual({ adopted: 1, invoiceIds: ['inv-1'], skipped: [] });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('adoption refused'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('adopted 1 orphan invoice(s): inv-1'));
  });
});

describe('runPending and the orphan sweep', () => {
  test('a failed adoption sweep never costs the day\'s due touches (Codex r2)', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    // Day 3 (step 0) is the same day on both cadences, so the ladder gate
    // does not re-time it: sent Sunday 08-02, due today.
    const row = seqRow({
      step_index: 0, next_touch_at: tenAmET('2026-08-05'),
      created_at: tenAmET('2026-08-02'), invoice_sent_at: tenAmET('2026-08-02'), invoice_created_at: tenAmET('2026-08-02'),
    });
    // Both revival reads come first under these gates; the batch is third.
    setupFullDb({ batchReads: [[], [], [row]] });
    // The sweep itself fails (e.g. its candidate query times out).
    runExclusive.mockRejectedValueOnce(new Error('statement timeout'));

    const result = await runPending();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('orphan adoption sweep failed — due touches still run'));
    expect(result.sent).toBe(1);
  });

  test('gate off: runPending never looks for orphans (no invoices-as-i query) and behaves as before', async () => {
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    // 'invoices as i' is deliberately NOT registered — a call to it throws,
    // proving adoption was never invoked when the gate is off.
    setupFullDb({ batchReads: [[row]] });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('adopt gate set while the legacy checker still runs: no sweep, one warning', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    // 'invoices as i' is NOT registered — a call to it throws, proving the
    // sweep never ran with the checker gate unset.
    setupFullDb({ batchReads: [[row]] });

    const result = await runPending();

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GATE_DUNNING_ADOPT_ORPHANS ignored: GATE_LATE_PAYMENT_CHECKER_OFF is not live'));
  });

  test('gate on: an adopted orphan sent 45 days ago lands on Day 60 with a future next_touch_at and is not sent this run', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = tenAmET('2026-06-21'); // 45 days before NOW (2026-08-05)
    const previewInvoice = {
      id: 'inv-orphan', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-orphan', sent_at: anchor,
    };
    const insertedRow = { id: 'seq-orphan', invoice_id: 'inv-orphan', customer_id: 'cust-orphan' };
    const { insertCalls } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-orphan', customer_id: 'cust-orphan', total: '150.00', credit_applied: '0', sent_at: anchor, sms_sent_at: null, created_at: anchor,
      }],
      previewInvoice,
      customer: { id: 'cust-orphan' },
      insertedRow,
      // Landing computes a next_touch_at of 2026-08-20 directly at insert —
      // weeks past NOW — so this SAME run's revival reads (ladder on ⇒
      // reviveLegacyFinishedSequences; checker retired ⇒
      // reviveReopenedLowStepSequences) and the main batch select (all
      // against `invoice_followup_sequences as s`) all find nothing due.
      batchReads: [[], [], []],
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await runPending();

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ invoice_id: 'inv-orphan', customer_id: 'cust-orphan', status: 'active', step_index: 4 });
    expect(insertCalls[0].next_touch_at).toEqual(tenAmET('2026-08-20'));
    expect(new Date(insertCalls[0].next_touch_at).getTime()).toBeGreaterThan(NOW.getTime());
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });

  test('gate on: an orphan whose landing day is exactly today lands on tomorrow 10:00 NY instead — never sent this run', async () => {
    process.env.GATE_DUNNING_ADOPT_ORPHANS = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const anchor = tenAmET('2026-07-06'); // Day 30 on both cadences — due today
    const previewInvoice = {
      id: 'inv-orphan', status: 'sent', payer_id: null, scheduled_send_error: null, customer_id: 'cust-orphan', sent_at: anchor,
    };
    const insertedRow = { id: 'seq-orphan', invoice_id: 'inv-orphan', customer_id: 'cust-orphan' };
    const { insertCalls } = setupFullDb({
      orphanRows: [{
        invoice_id: 'inv-orphan', customer_id: 'cust-orphan', total: '150.00', credit_applied: '0', sent_at: anchor, sms_sent_at: null, created_at: anchor,
      }],
      previewInvoice,
      customer: { id: 'cust-orphan' },
      insertedRow,
      batchReads: [[], [], []],
    });
    customerOnAutopay.mockResolvedValue(false);

    const result = await runPending();

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ invoice_id: 'inv-orphan', status: 'active', step_index: 3 });
    expect(insertCalls[0].next_touch_at).toEqual(tenAmET('2026-08-06'));
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });
});
