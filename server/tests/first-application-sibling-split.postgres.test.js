/**
 * Same-trip first-application billing review (owner ruling, #5021 redesign
 * — "flag, don't auto-split"): a reserved-accept slot selling two recurring
 * programs mints ONE draft invoice for the combined same-day total, linked
 * to the reserved row; the promoted sibling is left estimated_price NULL on
 * purpose (covered by that invoice while the two visits share a date). Once
 * a reschedule pulls one of them off the other's day, this module opens a
 * durable, invoice-keyed billing review IN THE SAME TRANSACTION as the date
 * write — it never touches the invoice's money or the visits' prices.
 * invoice-helpers.js's assertInvoiceCollectible (the one gate every
 * charge/send seam calls) refuses to collect while the review is open.
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

suite('first-application-sibling-split — same-trip billing review on date change', () => {
  let db;
  const {
    flagFirstApplicationInvoiceReviewOnDateChange,
    flagFirstApplicationInvoiceReviewOnDateChangeSafely,
    dateOnly,
  } = require('../services/first-application-sibling-split');
  const { assertInvoiceCollectible } = require('../services/invoice-helpers');
  const InvoiceService = require('../services/invoice');

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
  const SAME_DATE = '2026-10-01';
  async function fixture(trx, {
    reservedPrice = 153.60,
    sameDate = SAME_DATE,
    invoiceStatus = 'draft',
    invoiceExtra = {},
  } = {}) {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic billing-review fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true,
      estimated_price: reservedPrice,
    });
    await trx('scheduled_services').insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
      estimated_price: null,
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

  test('a diverging unpriced sibling opens a durable review on the shared invoice, and the invoice/visit money is untouched', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('review_opened');
    expect(result.opened).toBe(true);
    expect(result.invoiceId).toBe(ids.invoiceId);

    const state = await readState(trx, ids);
    // Never touched: same total/subtotal/line items as minted, and neither
    // visit's price moved.
    expect(Number(state.invoice.total)).toBe(153.60);
    expect(Number(state.invoice.subtotal)).toBe(153.60);
    expect(state.lineItems).toHaveLength(1);
    expect(Number(state.lineItems[0].amount)).toBe(153.60);
    expect(Number(state.pest.estimated_price)).toBe(153.60);
    expect(state.lawn.estimated_price).toBeNull();
    // The review itself is open, keyed by invoice id.
    expect(state.invoice.billing_review_opened_at).toBeTruthy();
    expect(state.invoice.billing_review_reason).toBe('sibling_date_diverged');
    const context = typeof state.invoice.billing_review_context === 'string'
      ? JSON.parse(state.invoice.billing_review_context) : state.invoice.billing_review_context;
    expect(context.divergingSiblingIds).toEqual([ids.lawnId]);

    const bell = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`first_application_billing_review:${ids.invoiceId}`]).first();
    expect(bell).toBeTruthy();
  }));

  test('the review is idempotent — a repeat call while still diverging never opens a second review or a duplicate bell', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const first = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(first.opened).toBe(true);
    const openedAt = (await readState(trx, ids)).invoice.billing_review_opened_at;

    const second = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(second.action).toBe('review_opened');
    expect(second.opened).toBe(false); // already open — first-write-wins

    const state = await readState(trx, ids);
    expect(state.invoice.billing_review_opened_at.getTime()).toBe(openedAt.getTime());
    const bells = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`first_application_billing_review:${ids.invoiceId}`]);
    expect(bells).toHaveLength(1);
  }));

  test('a move that rolls back leaves no review behind — the flag rolls back with the date write', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await expect(trx.transaction(async (inner) => {
      await inner('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(inner, ids.lawnId);
      throw new Error('simulated crash after the flag write, before commit');
    })).rejects.toThrow('simulated crash');

    const state = await readState(trx, ids);
    expect(state.invoice.billing_review_opened_at).toBeNull();
    expect(dateOnly(state.lawn.scheduled_date)).toBe(SAME_DATE);
  }));

  test('the open review blocks collection through the widened assertInvoiceCollectible gate', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    const invoice = await trx('invoices').where({ id: ids.invoiceId }).first();
    expect(() => assertInvoiceCollectible(invoice)).toThrow(/billing review/i);
  }));

  test('the open review blocks the scheduled-send claim (the automatic delivery seam)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    await trx('invoices').where({ id: ids.invoiceId }).update({
      status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000),
    });
    await expect(InvoiceService.claimInvoiceForSend(ids.invoiceId, { database: trx }))
      .rejects.toMatchObject({ code: 'billing_review_open' });
  }));

  test('clearing the review (the office\'s manual path) releases the collection hold', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    // The office edited the invoice by hand and now clears the review —
    // the same write POST /admin/invoices/:id/billing-review/clear performs.
    await trx('invoices').where({ id: ids.invoiceId })
      .update({ billing_review_opened_at: null, billing_review_reason: null, billing_review_context: null });
    const invoice = await trx('invoices').where({ id: ids.invoiceId }).first();
    expect(() => assertInvoiceCollectible(invoice)).not.toThrow();
  }));

  test('a move back to the same date auto-clears the review when the invoice was never touched', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('review_auto_cleared');

    const state = await readState(trx, ids);
    expect(state.invoice.billing_review_opened_at).toBeNull();
    expect(state.invoice.billing_review_reason).toBeNull();
  }));

  test('dates realign but the invoice was edited while the review was open — stays open, requires manual clear', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    // The office (or any other flow) touches the invoice without clearing
    // the review — updated_at moves off the snapshot taken at open time.
    // (Appended, not replaced — must stay matched by
    // isAutoGeneratedPayPerApplicationInvoice's title/notes check, or the
    // lookup would stop finding this invoice at all and the assertion below
    // would be testing the wrong branch.)
    const invoiceBefore = await trx('invoices').where({ id: ids.invoiceId }).first('notes');
    await trx('invoices').where({ id: ids.invoiceId })
      .update({ notes: `${invoiceBefore.notes} Staff note added.`, updated_at: new Date() });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });

    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('review_open_requires_manual_clear');
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();
  }));

  test('a recurring child\'s own date is unrelated to the accept-time split — skipped, no review', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const childId = randomUUID();
    await trx('scheduled_services').insert({
      id: childId, customer_id: ids.customerId, source_estimate_id: ids.estimateId,
      recurring_parent_id: ids.lawnId, scheduled_date: '2026-11-01',
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null,
    });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, childId);
    expect(result).toEqual({ action: 'skipped', reason: 'not_estimate_anchor' });
  }));

  test('no sibling on the estimate — skipped, no review', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const soloId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Solo fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: soloId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 100,
    });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, soloId);
    expect(result).toEqual({ action: 'skipped', reason: 'no_siblings', moved: expect.objectContaining({ id: soloId }) });
  }));

  test('no first-application invoice for this group — skipped, no review', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceExtra: {} });
    await trx('invoices').where({ id: ids.invoiceId }).delete();
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_first_application_invoice');
  }));

  test('a void invoice is excluded — never re-opened for a review', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'void' });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_first_application_invoice');
  }));

  test('an already-completed sibling is a settled fact, not a diverging candidate', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', completed_at: new Date() });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_diverging_unpriced_sibling');
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeNull();
  }));

  test('the invoice-holding row itself moving off the sibling\'s date opens the same review', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.pestId }).update({ scheduled_date: '2026-10-03' });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.pestId);
    expect(result.action).toBe('review_opened');
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();
  }));

  describe('flagFirstApplicationInvoiceReviewOnDateChangeSafely — savepoint isolation', () => {
    test('a bad scheduledServiceId never poisons the caller\'s transaction', () => rollbackTest(async (trx) => {
      const result = await flagFirstApplicationInvoiceReviewOnDateChangeSafely(trx, 'not-a-valid-uuid', 'test');
      expect(result.action).toBe('error');
      // The caller's own transaction is still usable.
      await trx('customers').insert({ id: randomUUID(), first_name: 'still usable', phone: `qa-${randomUUID().slice(0, 8)}`, active: true });
    }));

    test('the plain function throws (no savepoint) on the same bad id', () => rollbackTest(async (trx) => {
      await expect(flagFirstApplicationInvoiceReviewOnDateChange(trx, 'not-a-valid-uuid')).rejects.toThrow();
    }));
  });
});
