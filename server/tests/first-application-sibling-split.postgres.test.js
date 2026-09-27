/**
 * Same-trip first-application resplit (prod 2026-09-26): a reserved-accept
 * slot selling two recurring programs mints ONE draft invoice for the
 * combined same-day total, linked to the reserved row; the promoted sibling
 * is left estimated_price NULL on purpose (covered by that invoice while the
 * two visits share a date). Once a reschedule pulls one of them off the
 * other's day, the shared invoice must be split so each visit's own
 * completion bills its own share instead of one over-charging today and the
 * other billing $0 tomorrow.
 *
 * Real PostgreSQL verification; run with
 * SIBLING_RESPLIT_TEST_DATABASE_URL pointing to a disposable local, managed
 * worktree QA, or isolated CI database. Every fixture rolls back.
 */
jest.setTimeout(60000);
const { randomUUID } = require('crypto');

const testUrl = process.env.SIBLING_RESPLIT_TEST_DATABASE_URL;
const local = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname)
  && new URL(testUrl).pathname.includes('sibling_resplit');
const managed = testUrl && process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
  && testUrl === process.env.DATABASE_URL
  && new URL(testUrl).pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
const ci = testUrl && process.env.CI === 'true' && testUrl === process.env.DATABASE_URL
  && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname) && new URL(testUrl).pathname === '/waves_test';
if (testUrl && !local && !managed && !ci) {
  throw new Error('Sibling-split tests require a dedicated local sibling_resplit, managed worktree QA, or isolated CI database.');
}
const suite = local || managed || ci ? describe : describe.skip;

suite('first-application-sibling-split — same-trip resplit on date change', () => {
  let db;
  const {
    reconcileFirstApplicationSplitOnDateChange, reconcileFirstApplicationSplitOnDateChangeSafely, splitFromSharedInvoiceId,
  } = require('../services/first-application-sibling-split');

  beforeAll(() => { db = require('knex')({ client: 'pg', connection: testUrl }); });
  afterAll(async () => { await db?.destroy(); await require('../models/db').destroy(); });

  async function rollbackTest(fn) {
    const trx = await db.transaction();
    try { await fn(trx); } finally { await trx.rollback(); }
  }

  // A reserved pest row (invoice-holding) + a promoted lawn parent
  // (unpriced sibling), both accepted off the same estimate on the same
  // day, exactly like a same-day accept that sold two recurring programs
  // into one reserved slot. Returns ids plus a reader for post-state.
  async function fixture(trx, {
    reservedPrice = 153.60,
    lawnSplit = 56.40,
    pestSplit = 97.20,
    sameDate = '2026-10-01',
    invoiceStatus = 'draft',
    invoiceExtra = {},
  } = {}) {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic sibling-split fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true,
      estimated_price: reservedPrice,
      recurring_template_overrides: JSON.stringify({ anchored_split_per_visit: pestSplit }),
    });
    await trx('scheduled_services').insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
      estimated_price: null,
      recurring_template_overrides: JSON.stringify({ anchored_split_per_visit: lawnSplit }),
    });
    const invoiceId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: pestId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: invoiceStatus, title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: reservedPrice, amount: reservedPrice }]),
      subtotal: reservedPrice, total: reservedPrice,
      ...invoiceExtra,
    });
    return { customerId, estimateId, pestId, lawnId, invoiceId };
  }

  async function readState(trx, { pestId, lawnId, invoiceId }) {
    const [pest, lawn, invoice] = await Promise.all([
      trx('scheduled_services').where({ id: pestId }).first(),
      trx('scheduled_services').where({ id: lawnId }).first(),
      trx('invoices').where({ id: invoiceId }).first(),
    ]);
    const lineItems = typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items;
    return { pest, lawn, invoice, lineItems };
  }

  test('unpriced sibling moves off the invoice date → invoice splits, both rows get their own share', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('split');

    const state = await readState(trx, ids);
    expect(Number(state.pest.estimated_price)).toBe(97.2);
    expect(Number(state.lawn.estimated_price)).toBe(56.4);
    expect(Number(state.invoice.total)).toBe(97.2);
    expect(Number(state.invoice.subtotal)).toBe(97.2);
    const line = state.lineItems.find((li) => li.description === 'First service application');
    expect(Number(line.amount)).toBe(97.2);
    expect(Number(line.unit_price)).toBe(97.2);
    // Explicit provenance is stamped on the SPLIT sibling, not the
    // invoice-holding row — completion checks this, never estimated_price
    // alone, before treating the row as no longer covered by a sibling.
    expect(splitFromSharedInvoiceId(state.lawn)).toBe(ids.invoiceId);
    expect(splitFromSharedInvoiceId(state.pest)).toBeNull();
  }));

  test('the invoice-holding (reserved) row moves instead → same split, from the other direction', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.pestId }).update({ scheduled_date: '2026-10-05' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.pestId);
    expect(result.action).toBe('split');

    const state = await readState(trx, ids);
    expect(Number(state.pest.estimated_price)).toBe(97.2);
    expect(Number(state.lawn.estimated_price)).toBe(56.4);
    expect(Number(state.invoice.total)).toBe(97.2);
  }));

  test('invoice already sent → declines, sibling stays covered (no split, no money touched)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', invoiceExtra: { sent_at: new Date() } });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_draft_first_application_invoice');

    const state = await readState(trx, ids);
    expect(state.lawn.estimated_price).toBeNull();
    expect(Number(state.pest.estimated_price)).toBe(153.6);
    expect(Number(state.invoice.total)).toBe(153.6);
  }));

  test('invoice already paid → declines even though status column still reads draft', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceExtra: { paid_at: new Date() } });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_draft_first_application_invoice');
    const state = await readState(trx, ids);
    expect(state.lawn.estimated_price).toBeNull();
  }));

  test('the invoice-holding row already completed → no change', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'completed', completed_at: new Date() });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('invoice_row_completed_or_missing');
    const state = await readState(trx, ids);
    expect(state.lawn.estimated_price).toBeNull();
    expect(Number(state.pest.estimated_price)).toBe(153.6);
  }));

  test('the unpriced sibling already completed → no change even off-date', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({
      scheduled_date: '2026-10-02', status: 'completed', completed_at: new Date(),
    });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_diverging_unpriced_sibling');
    const state = await readState(trx, ids);
    expect(state.lawn.estimated_price).toBeNull();
    expect(Number(state.pest.estimated_price)).toBe(153.6);
  }));

  test('a second move back to the same day, after the split, makes no further change (no double-reduce)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const first = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(first.action).toBe('split');

    // Move it back onto the same day as the (already-reduced) invoice row.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-01' });
    const second = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(second.action).toBe('skipped');
    expect(second.reason).toBe('no_diverging_unpriced_sibling');

    const state = await readState(trx, ids);
    // Stays split — no re-merge, no double reduction of the invoice line.
    expect(Number(state.pest.estimated_price)).toBe(97.2);
    expect(Number(state.lawn.estimated_price)).toBe(56.4);
    expect(Number(state.invoice.total)).toBe(97.2);
  }));

  test('a deposit-credit line on the invoice declines the resplit', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const withCredit = [
      { description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 },
      { description: 'Deposit credit', quantity: 1, unit_price: -20, amount: -20, category: 'deposit_credit' },
    ];
    await trx('invoices').where({ id: ids.invoiceId }).update({ line_items: JSON.stringify(withCredit), total: 133.60 });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('declined');
    expect(result.reason).toBe('deposit_credit_present');
    const state = await readState(trx, ids);
    expect(state.lawn.estimated_price).toBeNull();
    expect(Number(state.invoice.total)).toBe(133.6);
  }));

  test('a one-time setup-fee line on the invoice declines the resplit', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const withFee = [
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 },
      { description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 },
    ];
    await trx('invoices').where({ id: ids.invoiceId }).update({ line_items: JSON.stringify(withFee), total: 252.60 });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('declined');
    expect(result.reason).toBe('setup_fee_present');
    const state = await readState(trx, ids);
    expect(state.lawn.estimated_price).toBeNull();
  }));

  test('a discount/credit line on the invoice declines the resplit — never write the GROSS remaining onto estimated_price', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const withDiscount = [
      { description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 },
      { description: 'Accepted plan credit', quantity: 1, unit_price: -20, amount: -20, _kind: 'discount' },
    ];
    await trx('invoices').where({ id: ids.invoiceId }).update({ line_items: JSON.stringify(withDiscount), total: 133.60 });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('declined');
    expect(result.reason).toBe('discount_or_credit_present');
    const state = await readState(trx, ids);
    // No money moved anywhere — the reserved row keeps its ORIGINAL gross
    // price, never a "remaining" figure computed net of a discount it
    // never accounted for.
    expect(state.lawn.estimated_price).toBeNull();
    expect(Number(state.pest.estimated_price)).toBe(153.6);
    expect(Number(state.invoice.total)).toBe(133.6);
  }));

  test('an already-itemized invoice (per-member lines from itemizeFirstApplication) declines rather than treating one member line as the combined total', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    // What itemizeFirstApplication (GATE_VISIT_CLOSEOUT) produces: one line
    // PER member, each tagged client_id `scheduled_<id>_primary` — every one
    // of them matches lineIsBaseApplication. Picking "the first match" here
    // would treat the pest row's own $97.20 line as the WHOLE combined
    // total and wrongly peel $56.40 off it down to $40.80.
    const itemized = [
      { description: 'Quarterly Pest Control', client_id: `scheduled_${ids.pestId}_primary`, quantity: 1, unit_price: 97.20, amount: 97.20 },
      { description: 'Lawn Care', client_id: `scheduled_${ids.lawnId}_primary`, quantity: 1, unit_price: 56.40, amount: 56.40 },
    ];
    await trx('invoices').where({ id: ids.invoiceId }).update({ line_items: JSON.stringify(itemized) });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('declined');
    expect(result.reason).toBe('itemized_invoice');
    const state = await readState(trx, ids);
    // Untouched — neither the invoice nor either row's price moved.
    expect(state.lawn.estimated_price).toBeNull();
    expect(Number(state.pest.estimated_price)).toBe(153.6);
    expect(state.lineItems.find((li) => li.client_id === `scheduled_${ids.pestId}_primary`).amount).toBe(97.2);
  }));

  test('a non-anchor (recurring child) row moving is a no-op — only top-of-series rows are resplit candidates', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const childId = randomUUID();
    await trx('scheduled_services').insert({
      id: childId, customer_id: ids.customerId, source_estimate_id: ids.estimateId,
      recurring_parent_id: ids.lawnId, scheduled_date: '2027-01-01', service_type: 'Lawn Care', status: 'pending',
    });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, childId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('not_estimate_anchor');
  }));

  test('a row with no estimate linkage is a cheap no-op', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    const soloId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic solo fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true });
    await trx('scheduled_services').insert({ id: soloId, customer_id: customerId, scheduled_date: '2026-10-01', service_type: 'Pest Control', status: 'confirmed' });
    const result = await reconcileFirstApplicationSplitOnDateChange(trx, soloId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('not_estimate_anchor');
  }));

  describe('reconcileFirstApplicationSplitOnDateChangeSafely — savepoint isolation', () => {
    test('a successful split behaves identically through the safe wrapper', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await reconcileFirstApplicationSplitOnDateChangeSafely(trx, ids.lawnId, 'test');
      expect(result.action).toBe('split');
      const state = await readState(trx, ids);
      expect(Number(state.pest.estimated_price)).toBe(97.2);
      expect(Number(state.lawn.estimated_price)).toBe(56.4);
    }));

    // On Postgres, a failing statement aborts the WHOLE transaction it ran
    // in until something rolls it back — every later statement, including
    // the caller's own COMMIT, then fails too. A malformed uuid forces a
    // genuine server-side error (not one of the function's own graceful
    // declines) so this proves the safe wrapper's savepoint actually
    // recovers the caller's transaction instead of just catching a JS
    // exception that leaves the underlying connection poisoned.
    test('a genuine DB error inside the reconcile is contained — the caller transaction stays usable afterward', () => rollbackTest(async (trx) => {
      const result = await reconcileFirstApplicationSplitOnDateChangeSafely(trx, 'not-a-valid-uuid', 'test');
      expect(result.action).toBe('error');

      // If the savepoint had not absorbed the failure, this trx would now be
      // aborted and ANY further statement on it — including this one — would
      // throw "current transaction is aborted".
      const customerId = randomUUID();
      await trx('customers').insert({ id: customerId, first_name: 'Synthetic post-failure fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true });
      const row = await trx('customers').where({ id: customerId }).first('id');
      expect(row.id).toBe(customerId);
    }));

    test('calling the plain (non-safe) function directly with a bad id propagates — documents why callers with more work after it must use the safe wrapper', () => rollbackTest(async (trx) => {
      await expect(reconcileFirstApplicationSplitOnDateChange(trx, 'not-a-valid-uuid')).rejects.toThrow();
    }));
  });
});
