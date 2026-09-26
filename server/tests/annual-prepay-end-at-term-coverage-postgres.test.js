// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// ADMIN-BUG-R18: an "End of paid coverage" cancel records the term's cancel
// decision at once (status 'cancelled', renewal_decision 'cancel'), months
// before term_end. The refresh paths used to stop at ACTIVE_STATUSES right
// there, so a kept paid visit skipped later was never replaced and a
// hand-added replacement was never stamped (billed again at completion). An
// "End now + refund" cancel records the same decision after pulling every
// visit, and must stay untouched.
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

postgres('decided-lapse annual-prepay terms keep their coverage guarantees through term_end', () => {
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

  async function cancelCase(t, prepayDisposition, prepayTermOutcome) {
    await trx('cancellation_cases').insert({
      customer_id: t.customerId, snapshot: JSON.stringify({ prepayTermId: t.termId, prepayDisposition, prepayTermOutcome }),
    });
  }

  const decideCancel = (t, notes = null) => AnnualPrepayRenewals.recordDecision({ termId: t.termId, action: 'cancel', notes });

  test('an end-at-term lapse still replaces a skipped kept visit', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    expect(await trx('annual_prepay_terms').where({ id: t.termId }).first('status', 'renewal_decision'))
      .toEqual({ status: 'cancelled', renewal_decision: 'cancel' });

    const kept = await upcoming(t);
    await skip(kept[kept.length - 1]);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    expect(await coverage(t)).toHaveLength(4);
  });

  test('an end-at-term lapse still stamps a hand-added replacement so completion does not bill it again', async () => {
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

  test('the recorded end_at_term case keeps coverage after every kept visit is skipped', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    await cancelCase(t, 'end_at_term', 'ends_at_term');
    for (const visit of await coverage(t)) await skip(visit);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    expect((await coverage(t)).length).toBeGreaterThan(0);
  });

  test('a renewal-time lapse (no cancellation case) still replaces its last visit', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    for (const visit of await coverage(t)) await skip(visit);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    expect((await coverage(t)).length).toBeGreaterThan(0);
  });

  test('a cancellation being committed for the customer holds the reseed off until it finishes', async () => {
    const t = await seededTerm();
    await decideCancel(t);
    const kept = await upcoming(t);
    await skip(kept[kept.length - 1]);
    // Cancel plan's commit holds this session-level key for its whole run.
    const other = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    try {
      await other.raw('SELECT pg_advisory_lock(hashtext(?), hashtext(?::text))', ['admin-cancel-plan', t.customerId]);
      await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
      expect(await upcoming(t)).toHaveLength(kept.length - 1);
      await other.raw('SELECT pg_advisory_unlock(hashtext(?), hashtext(?::text))', ['admin-cancel-plan', t.customerId]);
    } finally {
      await other.destroy();
    }
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    expect(await upcoming(t)).toHaveLength(kept.length);
  });

  test('a disputed end-at-term lapse does not get its stamps or a replacement back', async () => {
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

    // Nothing reseeded for the skipped visit and nothing re-stamped.
    expect(await upcoming(t)).toHaveLength(kept.length - 1);
    expect((await coverage(t)).every((row) => row.prepaid_method === null)).toBe(true);
  });

  test('an end-now refund whose case write failed is still never reseeded (its decision note carries it)', async () => {
    const { END_NOW_DECISION_NOTE } = require('../services/admin-cancellation');
    const t = await seededTerm();
    const pulled = await coverage(t);
    await trx('scheduled_services').whereIn('id', pulled.map((v) => v.id)).update({ status: 'cancelled', updated_at: new Date() });
    await decideCancel(t, `Cancel plan (Admin) — ${END_NOW_DECISION_NOTE} to the customer (office refund task + cancellation case follow).`);

    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    await AnnualPrepayRenewals.refreshTermSnapshot(t.termId, trx);
    expect(await coverage(t)).toHaveLength(0);
  });

  test('an end-at-term lapse switched to end-now keeps its end-now evidence even when the case write fails', async () => {
    const { END_NOW_DECISION_NOTE, _private } = require('../services/admin-cancellation');
    const t = await seededTerm();
    await decideCancel(t, 'Cancel plan (Admin) — coverage kept through 2099-01-01; no renewal.');
    const pulled = await coverage(t);
    await trx('scheduled_services').whereIn('id', pulled.map((v) => v.id)).update({ status: 'cancelled', updated_at: new Date() });
    const endNowNote = `Cancel plan (Admin) — ${END_NOW_DECISION_NOTE} to the customer (office refund task + cancellation case follow).`;
    const term = await trx('annual_prepay_terms').where({ id: t.termId }).first();
    expect(await _private.decideTermCancel(term, null, endNowNote)).toEqual({ verified: true, fresh: false });
    // A retry leaves the note once.
    await _private.decideTermCancel(term, null, endNowNote);
    const notes = (await trx('annual_prepay_terms').where({ id: t.termId }).first('renewal_notes')).renewal_notes;
    expect(notes.split(END_NOW_DECISION_NOTE)).toHaveLength(2);

    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    expect(await coverage(t)).toHaveLength(0);
  });

  test('a failed end-now attempt does not block a later renewal lapse', async () => {
    const t = await seededTerm();
    await cancelCase(t, 'end_now_refund', 'skipped_processor_failed');
    await decideCancel(t);
    const kept = await upcoming(t);
    await skip(kept[kept.length - 1]);
    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    expect(await upcoming(t)).toHaveLength(kept.length);
  });

  test('a cancel commit re-runs the customer\'s coverage refresh when it releases its key, even when it fails', async () => {
    const previousGate = process.env.GATE_CANCEL_FLOW_V2;
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    const refresh = jest.spyOn(AnnualPrepayRenewals, 'refreshActiveTermsForCustomer');
    try {
      const customerId = randomUUID();
      await expect(require('../services/admin-cancellation').commitCancelPlan({ customerId, effectiveDate: 'someday' }))
        .rejects.toMatchObject({ code: 'invalid_effective_date' });
      expect(refresh).toHaveBeenCalledWith(customerId);
    } finally {
      refresh.mockRestore();
      if (previousGate === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
      else process.env.GATE_CANCEL_FLOW_V2 = previousGate;
    }
  });

  test('an end-now-refund cancel is never reseeded or stamped', async () => {
    const t = await seededTerm();
    const pulled = await coverage(t);
    await trx('scheduled_services').whereIn('id', pulled.map((v) => v.id)).update({ status: 'cancelled', updated_at: new Date() });
    await decideCancel(t);
    await cancelCase(t, 'end_now_refund', 'ended_now');
    const replacementId = await handAdded(t, pulled[pulled.length - 1]);
    const liveVisits = async () => (await trx('scheduled_services')
      .where({ customer_id: t.customerId }).whereNot('status', 'cancelled').pluck('id')).sort();
    const liveBefore = await liveVisits();
    const termBefore = await trx('annual_prepay_terms').where({ id: t.termId }).first('updated_at');

    await AnnualPrepayRenewals.refreshActiveTermsForCustomer(t.customerId, trx);
    // The customer refresh leaves this term row alone, exactly as before.
    expect(await trx('annual_prepay_terms').where({ id: t.termId }).first('updated_at')).toEqual(termBefore);
    // Neither refresh path reseeds a visit or stamps the hand-added one.
    await AnnualPrepayRenewals.refreshTermSnapshot(t.termId, trx);
    expect(await liveVisits()).toEqual(liveBefore);
    expect(await trx('scheduled_services').where({ id: replacementId }).first('prepaid_method', 'annual_prepay_term_id'))
      .toEqual({ prepaid_method: null, annual_prepay_term_id: null });
  });
});
