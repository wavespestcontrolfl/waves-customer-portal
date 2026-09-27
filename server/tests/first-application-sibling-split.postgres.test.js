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
    clearBillingReview,
    dateOnly,
  } = require('../services/first-application-sibling-split');
  const { assertInvoiceCollectible, billingReviewVersion, isInvoiceUndeliveredForBillingReview } = require('../services/invoice-helpers');
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

  test('a sibling priced by hand WITHOUT its date moving back must NOT auto-clear — dates, not price/completion, decide the auto-clear', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();

    // The office prices the sibling by hand (one documented manual-
    // resolution path) but never moves its date back AND never touches the
    // invoice-holder's invoice — that invoice still carries the FULL
    // combined total, so this sibling's own new price would double-bill
    // once combined with the still-uncollapsed shared invoice. A date-
    // changing write on some OTHER member of the group (simulated here by
    // calling the entry point directly on the now-priced sibling) must
    // still see this as unresolved, not auto-clear. #5021 round-3:
    // divergingSiblings no longer excludes a priced sibling (a sibling can
    // diverge AND carry its own price in the same write, and that must
    // still open/keep a review) — the sibling is still date-diverged, so
    // this re-flags the (already open) review rather than reaching
    // maybeAutoClearBillingReview at all; either way it is never resolved.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ estimated_price: 56.40 });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('review_opened');
    expect(result.opened).toBe(false); // already open — still unresolved, never auto-cleared
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();
  }));

  test('a sibling priced by hand and LATER moved back onto the invoice date must still NOT auto-clear', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    // Priced by hand first (while still diverged)...
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ estimated_price: 56.40 });
    // ...then some UNRELATED write moves its date back onto the invoice-
    // holder's date, without the invoice itself ever being touched. Dates
    // now match, the fingerprint is unchanged — but this sibling still
    // bills its own separate price AND the invoice-holder's invoice was
    // never reduced. Must still require the manual clear.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('review_open_requires_manual_clear');
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();
  }));

  test('a diverging sibling that simply completes on its still-diverged date must NOT auto-clear', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ completed_at: new Date() });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('review_open_requires_manual_clear');
    expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();
  }));

  test('a later, DIFFERENT divergence on the same invoice never drops the first sibling from the record', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    // A third member of the same estimate-accept group, also unpriced.
    const thirdId = randomUUID();
    await trx('scheduled_services').insert({
      id: thirdId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: SAME_DATE,
      service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
    });

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    let context = (await readState(trx, ids)).invoice.billing_review_context;
    expect(context.divergingSiblingIds).toEqual([ids.lawnId]);

    // The lawn sibling realigns, but the THIRD member now diverges instead
    // — the record must carry BOTH, not just the latest one.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    await trx('scheduled_services').where({ id: thirdId }).update({ scheduled_date: '2026-10-03' });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, thirdId);
    expect(result.action).toBe('review_opened');

    context = (await readState(trx, ids)).invoice.billing_review_context;
    expect(new Set(context.divergingSiblingIds)).toEqual(new Set([ids.lawnId, thirdId]));

    // Only once BOTH are back does it clear.
    await trx('scheduled_services').where({ id: thirdId }).update({ scheduled_date: SAME_DATE });
    const cleared = await flagFirstApplicationInvoiceReviewOnDateChange(trx, thirdId);
    expect(cleared.action).toBe('review_auto_cleared');
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

  test('auto-clear also resolves the standing admin bell — it never sits unread once there is nothing left to review', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    const bellDedupeKey = `first_application_billing_review:${ids.invoiceId}`;
    const bellBefore = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [bellDedupeKey]).first();
    expect(bellBefore.read_at).toBeNull();

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    const bellAfter = await trx('notifications').where({ id: bellBefore.id }).first();
    expect(bellAfter.read_at).toBeTruthy();
  }));

  test('a benign metadata edit (notes + updated_at, no money change) never blocks the auto-clear — the fingerprint is money-only, not updated_at', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    // Touches updated_at and notes — no money field changes at all.
    // (Appended, not replaced — must stay matched by
    // isAutoGeneratedPayPerApplicationInvoice's title/notes check, or the
    // lookup would stop finding this invoice at all and this test would be
    // exercising the wrong branch.)
    const invoiceBefore = await trx('invoices').where({ id: ids.invoiceId }).first('notes');
    await trx('invoices').where({ id: ids.invoiceId })
      .update({ notes: `${invoiceBefore.notes} internal memo added.`, updated_at: new Date() });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });

    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('review_auto_cleared');
  }));

  test('a money edit that never bumps updated_at still keeps the review open — detection never depends on updated_at', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    const before = await trx('invoices').where({ id: ids.invoiceId }).first('updated_at');
    // A hypothetical write path that changes real money but forgets to
    // bump updated_at (exactly the gap the fingerprint design closes).
    await trx('invoices').where({ id: ids.invoiceId }).update({ total: 999 });
    const after = await trx('invoices').where({ id: ids.invoiceId }).first('updated_at');
    expect(after.updated_at).toEqual(before.updated_at);

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('review_open_requires_manual_clear');
  }));

  test('dates realign but the invoice was edited while the review was open — stays open, requires manual clear', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

    // The office (or any other flow) edits the invoice's actual MONEY
    // without clearing the review — this must move the fingerprint
    // maybeAutoClearBillingReview compares (total/subtotal/discount_amount/
    // status/line items), never rely on updated_at as a proxy (a write
    // that changes money but forgets to bump updated_at must still count
    // as "touched").
    await trx('invoices').where({ id: ids.invoiceId }).update({ total: 200, subtotal: 200 });
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

  describe('flagFirstApplicationInvoiceReviewOnDateChangeSafely — savepoint isolation, fails CLOSED', () => {
    // Round-4 (Codex #5021 P1): the wrapper used to swallow a genuine
    // failure and return {action:'error'} while the CALLER's date write
    // still committed — recreating the combined-charge gap with only a log
    // entry. It now re-throws so the caller's own transaction rolls back
    // the whole move; the savepoint still isolates the failing statement
    // itself, so trx (this test's OWN transaction, one level up from the
    // savepoint) stays usable even though the wrapper's promise rejected.
    test('a bad scheduledServiceId propagates so the caller\'s own transaction rolls back', () => rollbackTest(async (trx) => {
      await expect(flagFirstApplicationInvoiceReviewOnDateChangeSafely(trx, 'not-a-valid-uuid', 'test'))
        .rejects.toThrow();
      // The savepoint isolated ONLY the failing statement — trx itself
      // (one level up) is still usable, e.g. for a caller inspecting state
      // before re-throwing further, or for this test's own cleanup.
      await trx('customers').insert({ id: randomUUID(), first_name: 'still usable', phone: `qa-${randomUUID().slice(0, 8)}`, active: true });
    }));

    test('the plain function throws (no savepoint) on the same bad id', () => rollbackTest(async (trx) => {
      await expect(flagFirstApplicationInvoiceReviewOnDateChange(trx, 'not-a-valid-uuid')).rejects.toThrow();
    }));
  });

  // ---------------------------------------------------------------------
  // Round-3 redesign (#5021 round-3 P1s): the hold only ever protects an
  // UNDELIVERED invoice; a delivered invoice gets the same durable review +
  // admin alert, never a block. Plus the round-3 findings themselves:
  // priced-but-still-diverged flagging, the stale-clear 409, the bell
  // reopening on recurrence, the live/canceled/refunded selection, and the
  // preclaimed-send recheck.
  // ---------------------------------------------------------------------
  describe('round-3: the hold is scoped to undelivered invoices only', () => {
    test('a DRAFT invoice\'s review is HELD — assertInvoiceCollectible refuses, reason is sibling_date_diverged', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      const state = await readState(trx, ids);
      expect(state.invoice.billing_review_reason).toBe('sibling_date_diverged');
      expect(() => assertInvoiceCollectible(state.invoice)).toThrow(/billing review/i);
    }));

    test('an already-DELIVERED (sent) invoice\'s review is an ALERT ONLY — assertInvoiceCollectible does NOT refuse, reason is sibling_date_diverged_after_delivery', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'sent', invoiceExtra: { sent_at: new Date(), token: randomUUID() } });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const state = await readState(trx, ids);
      // The durable record + bell still fire — same as the draft case —
      // but nothing about the invoice's own money or status changed, and
      // collection is never refused for it.
      expect(state.invoice.billing_review_opened_at).toBeTruthy();
      expect(state.invoice.billing_review_reason).toBe('sibling_date_diverged_after_delivery');
      expect(state.invoice.status).toBe('sent');
      expect(() => assertInvoiceCollectible(state.invoice)).not.toThrow();
      const bell = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
        .whereRaw("metadata->>'dedupeKey' = ?", [`first_application_billing_review:${ids.invoiceId}`]).first();
      expect(bell).toBeTruthy();
      expect(bell.body).toMatch(/already sent/i);
      expect(bell.body).toMatch(/nothing is on hold/i);
      expect(bell.body).not.toMatch(/automatic collection.*is on hold/i);
    }));

    test('a delivered invoice\'s review never blocks a resend through claimInvoiceForSend', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'sent', invoiceExtra: { sent_at: new Date() } });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy();
      const claim = await InvoiceService.claimInvoiceForSend(ids.invoiceId, { database: trx });
      expect(claim.claimed).toBe(true);
    }));
  });

  describe('round-4 (Codex P1): a DRAFT invoice carrying a delivery stamp is treated as delivered', () => {
    // Pure-function check — no DB: a draft row is ambiguous the same way
    // 'scheduled'/'sending' already are (bookkeeping can restore or retain
    // 'draft' after the invoice actually reached the customer; the existing
    // first-delivery-claim tests explicitly cover a draft row carrying
    // email_sent_at). Applying the delivery-stamp check to 'draft' too is
    // what stops that row from reading as unconditionally undelivered.
    test('isInvoiceUndeliveredForBillingReview: a draft WITH a delivery stamp reads as delivered; a draft with none still reads as undelivered', () => {
      expect(isInvoiceUndeliveredForBillingReview({ status: 'draft', email_sent_at: new Date() })).toBe(false);
      expect(isInvoiceUndeliveredForBillingReview({ status: 'draft', sms_sent_at: new Date() })).toBe(false);
      expect(isInvoiceUndeliveredForBillingReview({ status: 'draft', sent_at: new Date() })).toBe(false);
      expect(isInvoiceUndeliveredForBillingReview({ status: 'draft' })).toBe(true);
    });

    test('a draft invoice with email_sent_at set is ALERT ONLY — assertInvoiceCollectible does NOT refuse, and it never blocks a resend', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft', invoiceExtra: { email_sent_at: new Date() } });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const state = await readState(trx, ids);
      // The durable record + bell still fire — same as any other divergence
      // — but the invoice already reached the customer, so the reason and
      // the collectibility check both read it as delivered, not held.
      expect(state.invoice.billing_review_opened_at).toBeTruthy();
      expect(state.invoice.billing_review_reason).toBe('sibling_date_diverged_after_delivery');
      expect(state.invoice.status).toBe('draft');
      expect(() => assertInvoiceCollectible(state.invoice)).not.toThrow();
      const claim = await InvoiceService.claimInvoiceForSend(ids.invoiceId, { database: trx });
      expect(claim.claimed).toBe(true);
    }));
  });

  describe('round-3: priced-but-still-diverged still opens the review', () => {
    test('update-details setting date AND price in the same write still opens a review — divergence alone is enough', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      // A single write moving the date and pricing the sibling at once
      // (exactly what admin-schedule.js's update-details route can do).
      await trx('scheduled_services').where({ id: ids.lawnId })
        .update({ scheduled_date: '2026-10-02', estimated_price: 56.40 });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const state = await readState(trx, ids);
      expect(state.invoice.billing_review_context.divergingSiblingIds).toEqual([ids.lawnId]);
      // And it must NOT auto-clear later just because the sibling has a
      // price — auto-clear still requires estimated_price == null too.
      const again = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(again.action).toBe('review_opened');
      expect(again.opened).toBe(false);
    }));
  });

  describe('round-3: invoice selection reuses the authoritative live/canceled/refunded precedence', () => {
    test('a newer CANCELED replacement invoice never shadows an older LIVE invoice', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft' });
      // A second, NEWER invoice for the SAME invoice-holding row — minted
      // in error and immediately canceled. Under the old
      // orderBy(created_at desc).find(...) selection this newer row would
      // be picked outright; selectFirstApplicationInvoiceMatch must skip
      // it and fall through to the older LIVE one.
      const canceledId = randomUUID();
      await trx('invoices').insert({
        id: canceledId, customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
        status: 'canceled', title: 'First Service Application',
        notes: `Auto-generated from accepted estimate #${ids.estimateId}. Customer selected pay per application — first application only.`,
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 }]),
        subtotal: 153.60, total: 153.60,
        created_at: new Date(Date.now() + 60000), // strictly newer than the fixture's own invoice
      });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      expect(result.invoiceId).toBe(ids.invoiceId); // the OLDER live invoice, not the newer canceled one
      const canceled = await trx('invoices').where({ id: canceledId }).first();
      expect(canceled.billing_review_opened_at).toBeNull(); // untouched
    }));
  });

  describe('round-3: bell reopens on a later, separate recurrence', () => {
    test('a review that auto-cleared and then recurs re-bells unread, even though the text is identical to the first opening', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      const dedupeKey = `first_application_billing_review:${ids.invoiceId}`;
      const firstBell = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
        .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first();
      expect(firstBell.read_at).toBeNull();

      // Realigns and the invoice was never touched — auto-clears, and the
      // bell is marked read (existing behavior).
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
      const cleared = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(cleared.action).toBe('review_auto_cleared');
      const readBell = await trx('notifications').where({ id: firstBell.id }).first();
      expect(readBell.read_at).toBeTruthy();

      // The SAME sibling diverges again — same estimate, same invoice,
      // same eventual message text — but this is a NEW opening (a fresh
      // billing_review_opened_at) and must re-bell unread, not stay
      // silently deduped against the read row above.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-03' });
      const reopened = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(reopened.action).toBe('review_opened');
      expect(reopened.opened).toBe(true);
      const bellAgain = await trx('notifications').where({ id: firstBell.id }).first();
      expect(bellAgain.read_at).toBeNull();
    }));
  });

  describe('round-3: stale clear is refused with a version mismatch', () => {
    test('clearBillingReview refuses a stale version — a NEW divergence landed after the operator read the page', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      // The operator's page reads the invoice and captures this version.
      const seenInvoice = await trx('invoices').where({ id: ids.invoiceId }).first();
      const staleVersion = billingReviewVersion(seenInvoice);
      expect(staleVersion).toEqual(expect.any(String));

      // A THIRD member of the group diverges too, in the meantime —
      // appends to the SAME still-open review (accumulates, never
      // replaces — see openBillingReview), which changes the context and
      // therefore the version.
      const thirdId = randomUUID();
      await trx('scheduled_services').insert({
        id: thirdId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: SAME_DATE,
        service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
      });
      await trx('scheduled_services').where({ id: thirdId }).update({ scheduled_date: '2026-10-03' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, thirdId);

      // The operator's Clear click, built from the STALE version, is refused.
      const stale = await clearBillingReview(ids.invoiceId, staleVersion, trx);
      expect(stale.code).toBe('stale');
      expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeTruthy(); // still open

      // The correct, freshly-read version clears it.
      const freshInvoice = await trx('invoices').where({ id: ids.invoiceId }).first();
      const freshVersion = billingReviewVersion(freshInvoice);
      const cleared = await clearBillingReview(ids.invoiceId, freshVersion, trx);
      expect(cleared.code).toBe('cleared');
      expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeNull();
    }));

    test('clearBillingReview is idempotent (no review open) and 404s on a missing invoice', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      const idempotent = await clearBillingReview(ids.invoiceId, 'whatever-version', trx);
      expect(idempotent.code).toBe('idempotent');
      const missing = await clearBillingReview(randomUUID(), 'whatever-version', trx);
      expect(missing.code).toBe('not_found');
    }));
  });

  describe('round-3: a review can open WHILE a preclaimed send holds the row at \'sending\'', () => {
    // The actual provider-handoff recheck (the last step before dispatch,
    // catching a review that opens AFTER a preclaim) lives in invoice.js's
    // sendViaSMS and invoice-email.js's sendInvoiceEmail — their own
    // withInvoiceDepositSettlement callbacks, exercised with mocks in
    // invoice-sms-provider-handoff.test.js ("refuses the preclaimed
    // handoff when a billing review opened after the claim, right before
    // the provider is called") since a real send needs a live SMS/email
    // provider this PG suite does not have. What this module owns, and
    // what a real PostgreSQL run proves here: the review genuinely CAN
    // open while the invoice sits claimed at 'sending' (status alone
    // never blocks the flag write), and the resulting row is exactly the
    // shape that recheck depends on (billing_review_opened_at set, status
    // inside UNDELIVERED_INVOICE_STATUSES).
    test('a review opens normally on a row already claimed at \'sending\', and assertInvoiceCollectible reads it as held', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft' });
      // Simulate the scheduled-send worker's own preclaim: it already
      // flipped 'scheduled' -> 'sending' and holds a claim token.
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'sending', send_claim_token: randomUUID() });
      // A CONCURRENT date-diverging move opens the review while the row
      // sits claimed at 'sending' — before the worker calls back in with
      // allowClaimed:true to actually hand off to the provider.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const invoice = (await readState(trx, ids)).invoice;
      expect(invoice.billing_review_opened_at).toBeTruthy();
      expect(invoice.status).toBe('sending');
      expect(() => assertInvoiceCollectible(invoice)).toThrow(/billing review/i);
    }));

    // Codex #5021 round-3 pre-push P1: claimInvoiceForSend flips ANY
    // claimed row to 'sending' — a first send AND a resend of an
    // ALREADY-delivered invoice both read as 'sending' by status alone.
    // A review opened while a RESEND (not a first send) sits claimed at
    // 'sending' must stay alert-only — the customer already has an
    // earlier copy of this invoice — proven here by a delivery stamp
    // (sent_at) from a prior send that predates this resend claim.
    test('a review that opens while a RESEND of an already-delivered invoice sits claimed at \'sending\' stays alert-only, not held', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft' });
      // This invoice was delivered once already (sent_at set)...
      await trx('invoices').where({ id: ids.invoiceId }).update({ sent_at: new Date('2026-01-01') });
      // ...and is now claimed again for a RESEND, which also parks it at
      // 'sending' — status alone is identical to the never-delivered case.
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'sending', send_claim_token: randomUUID() });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const invoice = (await readState(trx, ids)).invoice;
      expect(invoice.billing_review_opened_at).toBeTruthy();
      expect(invoice.billing_review_reason).toBe('sibling_date_diverged_after_delivery');
      expect(invoice.status).toBe('sending');
      // The delivery stamp is what makes the difference — assertInvoiceCollectible
      // must NOT throw for this resend-in-flight, unlike the never-delivered
      // 'sending' case just above.
      expect(() => assertInvoiceCollectible(invoice)).not.toThrow();
    }));

    // Codex #5021 round-3 pre-push P1 (second round): 'scheduled' is
    // ambiguous the SAME way 'sending' is, not just at rest. A combined
    // send that delivered its SMS leg but held/failed its email leg
    // restores the row to 'scheduled' for a retry (invoice.js's
    // processScheduledSends restoreClaimedInvoice branches) WITH
    // sms_sent_at already stamped — genuinely partially delivered, even
    // though the status alone reads exactly like a never-sent queued row.
    test('a review that opens on a \'scheduled\' row already carrying a delivery stamp (partial send, email retry pending) stays alert-only, not held', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft' });
      // The SMS leg delivered; the email leg is still pending — the row
      // was restored to 'scheduled' to retry it.
      await trx('invoices').where({ id: ids.invoiceId }).update({
        status: 'scheduled', sms_sent_at: new Date('2026-01-01'), scheduled_send_at: new Date(Date.now() - 60000),
      });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const invoice = (await readState(trx, ids)).invoice;
      expect(invoice.billing_review_reason).toBe('sibling_date_diverged_after_delivery');
      expect(() => assertInvoiceCollectible(invoice)).not.toThrow();
      // The scheduled-send worker's own due-claim query must still be able
      // to pick this row up and finish delivering the pending email leg —
      // the review must never block the completion of a delivery that
      // already partially reached the customer.
      const claimed = await InvoiceService._claimDueScheduledInvoiceForSend(trx, ids.invoiceId);
      expect(claimed).toBeTruthy();
      expect(claimed.status).toBe('sending');
    }));

    // The contrasting case: a GENUINELY never-delivered 'scheduled' row
    // (no stamps at all) must still be blocked from the automatic queue —
    // the fix must not simply stop enforcing the hold for 'scheduled'.
    test('a review on a genuinely never-delivered \'scheduled\' row still blocks the due-claim query', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'draft' });
      await trx('invoices').where({ id: ids.invoiceId }).update({
        status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000),
      });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      const invoice = (await readState(trx, ids)).invoice;
      expect(invoice.billing_review_reason).toBe('sibling_date_diverged');
      expect(() => assertInvoiceCollectible(invoice)).toThrow(/billing review/i);
      const claimed = await InvoiceService._claimDueScheduledInvoiceForSend(trx, ids.invoiceId);
      expect(claimed).toBeNull();
    }));
  });

  // ---------------------------------------------------------------------
  // Follow-up fix (post-#5021 pre-push audit finding): a shared invoice the
  // office already manually resolved (split by hand, then Clear) must not
  // be re-held by a LATER, unrelated reschedule that pattern-matches the
  // same invoice. clearBillingReview now records a resolution (the exact
  // sibling ids reviewed + the invoice's own money fingerprint at the
  // clear) instead of nulling billing_review_context, and
  // flagFirstApplicationInvoiceReviewOnDateChange checks it before opening
  // a fresh review. Auto-clear (realignment, nobody reviewed anything)
  // deliberately records no such resolution.
  // ---------------------------------------------------------------------
  describe('follow-up fix: a manually-resolved invoice is not re-held by an unrelated later reschedule', () => {
    test('manual clear, then the SAME sibling moves again (still diverged) — no reopen', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

      // The office splits the invoice by hand (no money change modeled
      // here — the resolution's own fingerprint is taken AT the clear, so
      // it always matches whatever the office left behind) and clears it.
      const seen = await trx('invoices').where({ id: ids.invoiceId }).first();
      const version = billingReviewVersion(seen);
      const cleared = await clearBillingReview(ids.invoiceId, version, trx, 'tech-adam');
      expect(cleared.code).toBe('cleared');
      const clearedState = await readState(trx, ids);
      expect(clearedState.invoice.billing_review_opened_at).toBeNull();
      const resolvedContext = clearedState.invoice.billing_review_context;
      expect(resolvedContext.resolvedAt).toEqual(expect.any(String));
      expect(resolvedContext.resolvedBy).toBe('tech-adam');
      expect(resolvedContext.resolvedSiblingIds).toEqual([ids.lawnId]);

      // The SAME sibling moves again — still diverged, just a different day
      // — an unrelated later reschedule, not a new mismatch.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-05' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('already_resolved_by_manual_clear');
      const finalState = await readState(trx, ids);
      expect(finalState.invoice.billing_review_opened_at).toBeNull();
    }));

    test('manual clear, then a NEW, unresolved sibling diverges — reopens', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      const thirdId = randomUUID();
      await trx('scheduled_services').insert({
        id: thirdId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: SAME_DATE,
        service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
      });

      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      const seen = await trx('invoices').where({ id: ids.invoiceId }).first();
      const version = billingReviewVersion(seen);
      const cleared = await clearBillingReview(ids.invoiceId, version, trx);
      expect(cleared.code).toBe('cleared');

      // The resolved sibling realigns (the office's own fix) — no current
      // divergence at all right now.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });

      // A DIFFERENT, never-reviewed member of the same group diverges.
      await trx('scheduled_services').where({ id: thirdId }).update({ scheduled_date: '2026-10-03' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, thirdId);
      expect(result.action).toBe('review_opened');
      expect(result.opened).toBe(true);
      const state = await readState(trx, ids);
      expect(state.invoice.billing_review_opened_at).toBeTruthy();
      expect(state.invoice.billing_review_context.divergingSiblingIds).toEqual([thirdId]);
    }));

    // Round-4 Codex P1 (second pre-push round): findLockedFirstApplication-
    // Invoice identifies the invoice by pattern-matching auto-generated
    // title/notes TEXT — staff rewriting that text while splitting the
    // invoice by hand (an ordinary edit through the SAME PUT route) must
    // not permanently blind the DATE-CHANGE chokepoint too, not just the
    // money-edit one. The durable-provenance fallback lives in the SHARED
    // findLockedFirstApplicationInvoice, so both paths get it.
    test('manual clear, then the notes are rewritten (breaking the text-match), then a NEW sibling diverges by DATE — still reopens', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      const thirdId = randomUUID();
      await trx('scheduled_services').insert({
        id: thirdId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: SAME_DATE,
        service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
      });

      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      const seen = await trx('invoices').where({ id: ids.invoiceId }).first();
      const version = billingReviewVersion(seen);
      const cleared = await clearBillingReview(ids.invoiceId, version, trx);
      expect(cleared.code).toBe('cleared');

      // The office rewrites the auto-generated notes while splitting the
      // invoice by hand — the text-match's own required substrings are
      // gone for good.
      await trx('invoices').where({ id: ids.invoiceId })
        .update({ notes: 'Split by hand 2026-10-02 — see office notes', title: 'Pest control invoice' });

      // A DIFFERENT, never-reviewed member of the same group diverges — via
      // a DATE change this time, not a money edit.
      await trx('scheduled_services').where({ id: thirdId }).update({ scheduled_date: '2026-10-03' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, thirdId);
      expect(result.action).toBe('review_opened');
      expect(result.opened).toBe(true);
      const state = await readState(trx, ids);
      expect(state.invoice.billing_review_opened_at).toBeTruthy();
    }));

    test('auto-clear (realignment, nobody reviewed anything), then a re-divergence reopens', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);

      // Realigns with the invoice untouched — auto-clears, recording NO
      // resolution (context is fully nulled, not a resolution record).
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
      const autoCleared = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(autoCleared.action).toBe('review_auto_cleared');
      expect((await readState(trx, ids)).invoice.billing_review_context).toBeNull();

      // The SAME sibling diverges again — must reopen normally; there is no
      // resolution on record to suppress it (nobody manually reviewed the
      // auto-cleared state).
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-04' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      expect(result.opened).toBe(true);
    }));

    test('manual clear, then the invoice is simply sent/paid (status-only change, no money change) — still does NOT reopen for the same resolved sibling', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      const seen = await trx('invoices').where({ id: ids.invoiceId }).first();
      const version = billingReviewVersion(seen);
      await clearBillingReview(ids.invoiceId, version, trx);

      // The invoice simply progresses through its ordinary delivery
      // lifecycle after the clear — sent, then paid — with NO money change
      // at all. The resolution's own fingerprint must be money-only (never
      // status), or this alone would look like "the invoice changed" and
      // wrongly reopen a correctly-resolved review.
      await trx('invoices').where({ id: ids.invoiceId })
        .update({ status: 'sent', sent_at: new Date(), token: randomUUID() });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid' });

      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-07' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('already_resolved_by_manual_clear');
      expect((await readState(trx, ids)).invoice.billing_review_opened_at).toBeNull();
    }));

    test('manual clear, then the invoice looks re-combined (money fingerprint changed) — reopens even for the previously-resolved sibling', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      const seen = await trx('invoices').where({ id: ids.invoiceId }).first();
      const version = billingReviewVersion(seen);
      await clearBillingReview(ids.invoiceId, version, trx);

      // Something changes the invoice's own money AFTER the clear (e.g. a
      // later edit that re-combines the total) — the resolution's
      // fingerprint no longer matches.
      await trx('invoices').where({ id: ids.invoiceId }).update({ total: 999, subtotal: 999 });

      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-06' });
      const result = await flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId);
      expect(result.action).toBe('review_opened');
      expect(result.opened).toBe(true);
    }));
  });
});
