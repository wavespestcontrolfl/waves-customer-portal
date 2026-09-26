// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// ADMIN-BUG-R18 (re-cut of #4911): an "End of paid coverage" cancel (and a
// renewal-time lapse) records the term's cancel decision at once — status
// 'cancelled', renewal_decision 'cancel' — months before term_end. The write
// side used to stop at ACTIVE_STATUSES right there, so a hand-added
// replacement was never stamped (billed again at completion) and a skipped
// kept visit was never replaced. The decision now carries its disposition
// (annual_prepay_terms.cancel_disposition): an end-at-term lapse keeps its
// paid visits — per-edit refreshes attach and stamp, the nightly sweep
// replaces a skipped one — and an "End now + refund" lapse is never touched.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const SERVICE = 'Quarterly Pest Control';
const ymdOffset = (days) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);

postgres('end-at-term annual-prepay lapses keep their paid visits through term_end', () => {
  let database;
  let trx;
  let AnnualPrepayRenewals;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function seededTerm() {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const termId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Lapse', email: `${customerId}@example.invalid`,
      phone: `fixture-${customerId.slice(0, 8)}`,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'paid', paid_at: new Date(), subtotal: 480, total: 480,
      line_items: '[]', invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(),
    });
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, prepay_invoice_id: invoiceId, status: 'active',
      coverage_service_type: SERVICE, coverage_visit_count: 4, coverage_cadence: 'quarterly',
      prepay_amount: 480, term_start: ymdOffset(-30), term_end: ymdOffset(335),
    });
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(customerId, trx);
    const t = { customerId, invoiceId, termId };
    expect(await coverage(t)).toHaveLength(4);
    return t;
  }

  async function coverage(t) {
    const term = await trx('annual_prepay_terms').where({ id: t.termId }).first();
    return AnnualPrepayRenewals._private.coverageRowsForTerm(term, trx);
  }

  async function upcoming(t) {
    return (await coverage(t)).filter((row) => row.scheduled_date >= new Date());
  }

  async function skip(visit) {
    await trx('scheduled_services').where({ id: visit.id }).update({ status: 'skipped', updated_at: new Date() });
  }

  async function handAdded(t, after) {
    const id = randomUUID();
    const d = new Date(after.scheduled_date);
    d.setUTCDate(d.getUTCDate() + 3);
    await trx('scheduled_services').insert({
      id, customer_id: t.customerId, scheduled_date: d.toISOString().slice(0, 10), service_type: SERVICE, status: 'pending',
    });
    return id;
  }

  const disposition = async (t) => (await trx('annual_prepay_terms').where({ id: t.termId }).first('cancel_disposition')).cancel_disposition;
  const decideCancel = (t, { notes = null, disposition: d = undefined } = {}) => AnnualPrepayRenewals.recordDecision({
    termId: t.termId, action: 'cancel', notes, ...(d ? { disposition: d } : {}),
  });
  const sweep = () => AnnualPrepayRenewals.reconcileCoveredTermsSweep({ conn: trx });
  const pullAll = async (t) => {
    const pulled = await coverage(t);
    await trx('scheduled_services').whereIn('id', pulled.map((v) => v.id)).update({ status: 'cancelled', updated_at: new Date() });
    return pulled;
  };

  test('a cancel decision records its disposition with it — end_at_term by default, end_now_refund when Cancel plan ends it now', async () => {
    const lapse = await seededTerm();
    await decideCancel(lapse);
    expect(await trx('annual_prepay_terms').where({ id: lapse.termId }).first('status', 'renewal_decision', 'cancel_disposition'))
      .toEqual({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' });
    const endNow = await seededTerm();
    await decideCancel(endNow, { disposition: 'end_now_refund' });
    expect(await disposition(endNow)).toBe('end_now_refund');
    await expect(decideCancel(await seededTerm(), { disposition: 'someday' })).rejects.toThrow('invalid cancel disposition');
  });

  test('an end-at-term lapse stamps a hand-added replacement on a per-edit refresh, so completion does not bill it again', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    const kept = await upcoming(t);
    const victim = kept[kept.length - 1];
    await skip(victim);
    const replacementId = await handAdded(t, victim);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);

    const replacement = await trx('scheduled_services').where({ id: replacementId }).first();
    expect(replacement.prepaid_method).toBe('annual_prepay_invoice');
    expect(replacement.annual_prepay_term_id).toBe(t.termId);
    expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(replacement, trx)).toBe(true);
  });

  test('a per-edit refresh never creates a visit for an end-at-term lapse; the nightly sweep replaces the skipped one', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    const kept = await upcoming(t);
    await skip(kept[kept.length - 1]);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await AnnualPrepayRenewals.refreshTermSnapshot(t.termId, trx);
    expect(await upcoming(t)).toHaveLength(kept.length - 1);
    await sweep();
    expect(await upcoming(t)).toHaveLength(kept.length);
    // Idempotent: a second night adds nothing.
    await sweep();
    expect(await upcoming(t)).toHaveLength(kept.length);
  });

  test('the nightly sweep never books a replacement in the past — the office is asked to book it (pre-push P1)', async () => {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const t = await seededTerm();
    await decideCancel(t);
    // The first paid visit is skipped on its day, and the next night's sweep
    // finds its cadence slot already behind it.
    const [first] = await coverage(t);
    await skip(first);
    const before = (await coverage(t)).length;
    const nextNight = etDateString(addETDays(new Date(`${String(first.scheduled_date instanceof Date ? first.scheduled_date.toISOString() : first.scheduled_date).slice(0, 10)}T12:00:00Z`), 1));
    const nightlySweep = () => AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: nextNight, conn: trx });
    const pastLive = () => trx('scheduled_services').where({ customer_id: t.customerId })
      .whereNotIn('status', ['skipped', 'cancelled']).where('scheduled_date', '<', nextNight);
    const notices = () => trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual-prepay-first-visit:${t.termId}:lapse_replacement_unscheduled`]);
    await nightlySweep();
    expect(await pastLive()).toHaveLength(0);
    expect(await coverage(t)).toHaveLength(before);
    const [notice] = await notices();
    expect(notice?.title).toMatch(/replacement booked/);
    // A second night neither seeds it nor stacks a second notice.
    await nightlySweep();
    expect(await pastLive()).toHaveLength(0);
    expect(await notices()).toHaveLength(1);
  });

  test('an end-now-refund lapse is never reseeded or stamped, by the refresh or the sweep', async () => {
    const t = await seededTerm();
    const pulled = await pullAll(t);
    await decideCancel(t, { disposition: 'end_now_refund' });
    const replacementId = await handAdded(t, pulled[pulled.length - 1]);
    const liveVisits = async () => (await trx('scheduled_services')
      .where({ customer_id: t.customerId }).whereNot('status', 'cancelled').pluck('id')).sort();
    const liveBefore = await liveVisits();
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await AnnualPrepayRenewals.refreshTermSnapshot(t.termId, trx);
    await sweep();
    expect(await liveVisits()).toEqual(liveBefore);
    expect(await trx('scheduled_services').where({ id: replacementId }).first('prepaid_method', 'annual_prepay_term_id'))
      .toEqual({ prepaid_method: null, annual_prepay_term_id: null });
  });

  test('an end-at-term lapse later ended now is upgraded in place and then left alone; the disposition never moves back', async () => {
    const { _private } = require('../services/admin-cancellation');
    const t = await seededTerm();
    await decideCancel(t, { notes: 'Cancel plan (Admin) — coverage kept through 2099-01-01; no renewal.' });
    await pullAll(t);
    const term = await trx('annual_prepay_terms').where({ id: t.termId }).first();
    expect(await _private.decideTermCancel(term, null, 'ended now', 'end_now_refund')).toEqual({ verified: true, fresh: false });
    expect(await disposition(t)).toBe('end_now_refund');
    // A retry, and a later end-at-term re-decision, leave it end_now_refund.
    expect(await _private.decideTermCancel(term, null, 'ended now', 'end_now_refund')).toEqual({ verified: true, fresh: false });
    await _private.decideTermCancel(term, null, 'kept', 'end_at_term');
    expect(await disposition(t)).toBe('end_now_refund');
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await sweep();
    expect(await coverage(t)).toHaveLength(0);
  });

  test('an end-now run that failed between pulling the visits and recording the disposition leaves the lapse untouched until it is repaired (pre-push P1)', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    // The operator ends it now: the acceptance is written before anything
    // destructive, the processor pulls every visit, and the run dies before
    // the disposition lands — the term still reads end_at_term.
    const [request] = await trx('service_requests').insert({
      customer_id: t.customerId, category: 'cancellation', subject: 'Cancel plan', source: 'admin', status: 'new',
      metadata: JSON.stringify({ cancel_plan: { scope: [], effectiveDate: 'now', prepayDisposition: null } }),
    }).returning('*');
    const pulled = await pullAll(t);
    const replacementId = await handAdded(t, pulled[pulled.length - 1]);
    expect(await disposition(t)).toBe('end_at_term');
    const liveVisits = async () => (await trx('scheduled_services')
      .where({ customer_id: t.customerId }).whereNot('status', 'cancelled').pluck('id')).sort();
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await sweep();
    expect(await liveVisits()).toEqual([replacementId]);
    expect(await trx('scheduled_services').where({ id: replacementId }).first('prepaid_method', 'annual_prepay_term_id'))
      .toEqual({ prepaid_method: null, annual_prepay_term_id: null });
    // The repair retry records the disposition and resolves the request:
    // still nothing is stamped or recreated.
    await AnnualPrepayRenewals.recordCancelDisposition({ termId: t.termId, disposition: 'end_now_refund' }, trx);
    await trx('service_requests').where({ id: request.id }).update({ status: 'resolved' });
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await sweep();
    expect(await liveVisits()).toEqual([replacementId]);
  });

  test('a cancellation being committed for the customer holds the nightly reseed off until it finishes', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    const kept = await upcoming(t);
    await skip(kept[kept.length - 1]);
    // Cancel plan's commit holds this session-level key for its whole run.
    const other = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    try {
      await other.raw('SELECT pg_advisory_lock(hashtext(?), hashtext(?::text))', ['admin-cancel-plan', t.customerId]);
      await sweep();
      expect(await upcoming(t)).toHaveLength(kept.length - 1);
      await other.raw('SELECT pg_advisory_unlock(hashtext(?), hashtext(?::text))', ['admin-cancel-plan', t.customerId]);
    } finally {
      await other.destroy();
    }
    await sweep();
    expect(await upcoming(t)).toHaveLength(kept.length);
  });

  test('a disputed end-at-term lapse gets neither its stamps nor a replacement back', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    // The chargeback reopens the prepay invoice; the dispute path clears the
    // decided lapse's stamps and suspends it through the paid-invoice gate.
    await trx('invoices').where({ id: t.invoiceId }).update({ status: 'overdue', paid_at: null });
    await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice(t.invoiceId, trx);
    const kept = await upcoming(t);
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.every((row) => row.prepaid_method === null)).toBe(true);
    await skip(kept[kept.length - 1]);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await sweep();
    expect(await upcoming(t)).toHaveLength(kept.length - 1);
    expect((await coverage(t)).every((row) => row.prepaid_method === null)).toBe(true);
  });

  test('an end-at-term lapse past its term_end is left alone', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    await trx('annual_prepay_terms').where({ id: t.termId }).update({ term_start: ymdOffset(-400), term_end: ymdOffset(-35) });
    const before = await trx('scheduled_services').where({ customer_id: t.customerId }).count('* as n').first();
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await sweep();
    expect(await trx('scheduled_services').where({ customer_id: t.customerId }).count('* as n').first()).toEqual(before);
  });

  test('an end-of-coverage decision reaching an ended-now term is a conflict, not a verified decision (GitHub r1 P1)', async () => {
    const { _private } = require('../services/admin-cancellation');
    const t = await seededTerm();
    await decideCancel(t, { disposition: 'end_now_refund' });
    const term = await trx('annual_prepay_terms').where({ id: t.termId }).first();
    expect(await _private.decideTermCancel(term, null, 'Cancel plan (Admin) — coverage kept; no renewal.', 'end_at_term'))
      .toEqual({ verified: false, fresh: false, conflictingDecision: 'end_now_refund' });
    expect(await disposition(t)).toBe('end_now_refund');
  });

  test('the nightly reseed of a legacy lapse with no linked visit fills its stored window — no first-activation slide (GitHub r1 P1)', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const termId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Legacy', email: `${customerId}@example.invalid`,
      phone: `fixture-${customerId.slice(0, 8)}` });
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, status: 'paid', paid_at: new Date(), subtotal: 480, total: 480,
      line_items: '[]', invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID() });
    const termEnd = ymdOffset(165);
    await trx('annual_prepay_terms').insert({ id: termId, customer_id: customerId, prepay_invoice_id: invoiceId,
      status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date(), cancel_disposition: 'end_at_term',
      coverage_service_type: SERVICE, coverage_visit_count: 4, coverage_cadence: 'quarterly', prepay_amount: 480,
      term_start: ymdOffset(-200), term_end: termEnd });
    // Legacy: the kept visits exist but were never linked to the term.
    for (const days of [12, 103]) {
      await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, scheduled_date: ymdOffset(days),
        service_type: SERVICE, status: 'pending' });
    }
    await sweep();
    const term = await trx('annual_prepay_terms').where({ id: termId }).first('term_end');
    expect(String(term.term_end instanceof Date ? term.term_end.toISOString() : term.term_end).slice(0, 10)).toBe(termEnd);
    expect(await trx('scheduled_services').where({ customer_id: customerId }).where('scheduled_date', '>', termEnd)).toHaveLength(0);
  });

  test('a failed column probe fails the cancel decision instead of recording it without a disposition (GitHub r1 P1)', async () => {
    const t = await seededTerm();
    AnnualPrepayRenewals._private.resetCachesForTests();
    const dbMock = require('../models/db');
    const real = dbMock.connection;
    // The column probe (a columnInfo read of annual_prepay_terms) fails;
    // every other statement runs as usual.
    dbMock.connection = new Proxy(real, {
      apply(target, thisArg, args) {
        const builder = Reflect.apply(target, thisArg, args);
        if (args[0] === 'annual_prepay_terms') builder.columnInfo = async () => { throw new Error('synthetic probe failure'); };
        return builder;
      },
    });
    try {
      await expect(decideCancel(t)).rejects.toThrow('synthetic probe failure');
    } finally {
      dbMock.connection = real;
    }
    expect(await trx('annual_prepay_terms').where({ id: t.termId }).first('status', 'renewal_decision', 'cancel_disposition'))
      .toEqual({ status: 'active', renewal_decision: null, cancel_disposition: null });
  });

  describe('backfill of decisions recorded before cancel_disposition', () => {
    const { backfillCancelDisposition } = require('../models/migrations/20260926120000_annual_prepay_terms_cancel_disposition');

    async function legacyLapse({ notes = null } = {}) {
      const t = await seededTerm();
      await trx('annual_prepay_terms').where({ id: t.termId }).update({
        status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: new Date(), renewal_notes: notes, cancel_disposition: null,
      });
      return t;
    }
    const cancelCase = (t, prepayDisposition, prepayTermOutcome) => trx('cancellation_cases').insert({
      customer_id: t.customerId, snapshot: JSON.stringify({ prepayTermId: t.termId, prepayDisposition, prepayTermOutcome }),
    });
    const cancelRequest = (t, cancelPlan) => trx('service_requests').insert({
      customer_id: t.customerId, category: 'cancellation', subject: 'Cancel plan', metadata: JSON.stringify({ cancel_plan: cancelPlan }),
    });

    test('the Eastern-time correction moves only the UTC-boundary misreadings (GitHub r1 P1)', async () => {
      const { correctCancelDispositionWindow } = require('../models/migrations/20260926130000_annual_prepay_terms_cancel_disposition_et_window');
      // A whole-account end-now request at an ET wall-clock moment of a
      // date taken from the term row, computed in SQL (DST-proof).
      const requestAt = (t, dayExpr, time) => trx('service_requests').insert({
        customer_id: t.customerId, category: 'cancellation', subject: 'Cancel plan',
        metadata: JSON.stringify({ cancel_plan: { scope: [], effectiveDate: 'now', prepayDisposition: null } }),
        created_at: trx.raw(`(select (${dayExpr} + time '${time}') at time zone 'America/New_York' from annual_prepay_terms where id = ?)`, [t.termId]),
      });
      const late = await legacyLapse();
      await requestAt(late, 'term_end', '23:30');
      const early = await legacyLapse();
      await requestAt(early, '(term_start - 1)', '22:00');
      const noted = await legacyLapse({ notes: 'Cancel plan (Admin) — ended now; unused-value refund owed to the customer.' });
      await requestAt(noted, '(term_start - 1)', '22:00');
      // Railway's session zone: the frozen backfill reads the date bounds at UTC midnight.
      await trx.raw("set local time zone 'UTC'");
      await backfillCancelDisposition(trx);
      expect(await disposition(late)).toBe('end_at_term');
      expect(await disposition(early)).toBe('end_now_refund');
      await correctCancelDispositionWindow(trx);
      expect(await disposition(late)).toBe('end_now_refund');
      expect(await disposition(early)).toBe('end_at_term');
      expect(await disposition(noted)).toBe('end_now_refund');
    });

    test('end-now evidence makes a legacy lapse end_now_refund; everything else is end_at_term; undecided terms stay null', async () => {
      const byNote = await legacyLapse({ notes: 'Cancel plan (Admin) — ended now; unused-value refund owed to the customer (office refund task + cancellation case follow).' });
      const byCase = await legacyLapse();
      await cancelCase(byCase, 'end_now_refund', 'decision_already_recorded');
      const byFailedCase = await legacyLapse();
      await cancelCase(byFailedCase, 'end_now_refund', 'skipped_processor_failed');
      const byRequest = await legacyLapse();
      await cancelRequest(byRequest, { scope: [], effectiveDate: 'now', prepayDisposition: null });
      const byScopedRequest = await legacyLapse();
      await cancelRequest(byScopedRequest, { scope: ['mosquito'], effectiveDate: 'now', prepayDisposition: null });
      const byEndAtTermRequest = await legacyLapse();
      await cancelRequest(byEndAtTermRequest, { scope: [], effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
      const plain = await legacyLapse({ notes: 'Renewal declined on the call.' });
      const undecided = await seededTerm();

      await backfillCancelDisposition(trx);
      expect(await disposition(byNote)).toBe('end_now_refund');
      expect(await disposition(byCase)).toBe('end_now_refund');
      expect(await disposition(byFailedCase)).toBe('end_at_term');
      expect(await disposition(byRequest)).toBe('end_now_refund');
      expect(await disposition(byScopedRequest)).toBe('end_at_term');
      expect(await disposition(byEndAtTermRequest)).toBe('end_at_term');
      expect(await disposition(plain)).toBe('end_at_term');
      expect(await disposition(undecided)).toBeNull();
      // Re-running fills nothing it already filled.
      await backfillCancelDisposition(trx);
      expect(await disposition(byRequest)).toBe('end_now_refund');
    });
  });
});
