/**
 * Same-trip first-application billing ALERT (owner ruling, 2026-09-27
 * redesign — "alert only, no hold"; supersedes the #5021 round-3..7 hold
 * design). A reserved-accept slot selling two recurring programs mints ONE
 * draft invoice for the combined same-day total, linked to the reserved
 * (priced) row; the promoted sibling is left estimated_price NULL on
 * purpose (covered by that invoice while the two visits share a date).
 * Once a reschedule pulls the unpriced sibling off the priced row's day,
 * this module raises a durable admin alert (notification-service.
 * notifyAdmin, category 'billing') IN THE SAME TRANSACTION as the date
 * write — it never touches the invoice's money, never holds collection,
 * never takes a new lock. The office splits the invoice by hand.
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

suite('first-application-sibling-split — same-trip billing alert on date change', () => {
  let db;
  const {
    flagFirstApplicationSiblingDivergence,
    flagFirstApplicationSiblingDivergenceSafely,
  } = require('../services/first-application-sibling-split');
  const notificationService = require('../services/notification-service');

  beforeAll(() => { db = require('knex')({ client: 'pg', connection: testUrl }); });
  afterAll(async () => { await db?.destroy(); await require('../models/db').destroy(); });

  async function rollbackTest(fn) {
    const trx = await db.transaction();
    try { await fn(trx); } finally { await trx.rollback(); }
  }

  const DEDUPE_KEY = (estimateId, siblingIds) => `first_application_sibling_divergence:${estimateId}:${[...siblingIds].map(String).sort().join(',')}`;

  // A reserved pest row (priced — the invoice-holder) + a promoted lawn
  // parent (unpriced sibling), both accepted off the same estimate on the
  // same day, exactly like a same-day accept that sold two recurring
  // programs into one reserved slot. Returns ids plus a reader for
  // post-state. `matchInvoiceText: false` mints an invoice whose
  // title/notes do NOT match the auto-generated pay-per-application
  // pattern, for the "invoice text unrecognizable" case.
  const SAME_DATE = '2026-10-01';
  async function fixture(trx, {
    reservedPrice = 153.60,
    sameDate = SAME_DATE,
    matchInvoiceText = true,
    noInvoice = false,
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
    });
    await trx('scheduled_services').insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
      estimated_price: null,
    });
    let invoiceId = null;
    if (!noInvoice) {
      invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: pestId,
        token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
        status: 'draft',
        title: matchInvoiceText ? 'First Service Application' : 'Custom invoice title',
        notes: matchInvoiceText
          ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`
          : 'A hand-edited note with nothing recognizable in it.',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: reservedPrice, amount: reservedPrice }]),
        subtotal: reservedPrice, total: reservedPrice,
      });
    }
    return { customerId, estimateId, pestId, lawnId, invoiceId };
  }

  async function readState(trx, { pestId, lawnId }) {
    const [pest, lawn] = await Promise.all([
      trx('scheduled_services').where({ id: pestId }).first(),
      trx('scheduled_services').where({ id: lawnId }).first(),
    ]);
    return { pest, lawn };
  }

  async function readBell(conn, dedupeKey) {
    return conn('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first();
  }

  test('a diverging unpriced sibling raises exactly one durable alert row, in the SAME transaction as the move — invoice/visit money untouched', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    expect(result.action).toBe('alert_raised');
    expect(result.estimateId).toBe(ids.estimateId);
    expect(result.invoiceId).toBe(ids.invoiceId);
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

    const state = await readState(trx, ids);
    // Never touched: neither visit's price moved.
    expect(Number(state.pest.estimated_price)).toBe(153.60);
    expect(state.lawn.estimated_price).toBeNull();
    const invoice = await trx('invoices').where({ id: ids.invoiceId }).first();
    expect(Number(invoice.total)).toBe(153.60);

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bells = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
    expect(bells).toHaveLength(1);
    expect(bells[0].link).toBe(`/admin/invoices?invoice=${ids.invoiceId}`);
    expect(bells[0].body).toContain('split it by hand');
    expect(bells[0].body).toContain(`Invoice`);
    expect(bells[0].read_at).toBeNull();
  }));

  test('the SAME still-open divergence, evaluated again, never opens a second alert row', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bells = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
    expect(bells).toHaveLength(1);
  }));

  test('a rolled-back move leaves no alert behind', async () => {
    const outer = await db.transaction();
    let ids;
    try {
      ids = await fixture(outer);
      await outer('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const result = await flagFirstApplicationSiblingDivergence(outer, ids.lawnId);
      expect(result.action).toBe('alert_raised');
      // Prove it's really there before the rollback.
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      expect(await readBell(outer, dedupeKey)).toBeTruthy();
    } finally {
      await outer.rollback();
    }
    // A FRESH connection, outside the rolled-back transaction — nothing
    // persisted: neither the customer/estimate fixture rows nor the alert.
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect(await readBell(db, dedupeKey)).toBeUndefined();
    expect(await db('scheduled_services').where({ id: ids.lawnId }).first()).toBeUndefined();
  });

  test('recurrence reopens the bell — a divergence read/dismissed by the office, then recurring, is unread again', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    // Office reads/dismisses it.
    await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });

    // The visits realign (no divergence — no alert call happens for a
    // realignment; nothing to assert there), then diverge again — the
    // SAME estimate, the SAME diverging sibling id, a genuine recurrence.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-03' });
    await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);

    const reopened = await readBell(trx, dedupeKey);
    expect(reopened.id).toBe(firstBell.id);
    expect(reopened.read_at).toBeNull();
  }));

  test('invoice text unrecognizable — the alert still fires, without a link, naming the estimate', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { matchInvoiceText: false });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    expect(result.action).toBe('alert_raised');
    expect(result.invoiceId).toBeNull();

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bell = await readBell(trx, dedupeKey);
    expect(bell).toBeTruthy();
    expect(bell.link).toBe(`/admin/estimates/${ids.estimateId}`);
    expect(bell.body).toContain(`Check the first-application invoice for estimate #${ids.estimateId}`);
  }));

  test('no first-application invoice at all — the alert still fires the same way', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { noInvoice: true });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    expect(result.action).toBe('alert_raised');
    expect(result.invoiceId).toBeNull();
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect(await readBell(trx, dedupeKey)).toBeTruthy();
  }));

  test('fully priced siblings — no alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02', estimated_price: 42 });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_diverging_sibling');
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect(await readBell(trx, dedupeKey)).toBeUndefined();
  }));

  test('an already-completed sibling is a settled fact, not a diverging candidate', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', completed_at: new Date() });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_diverging_sibling');
  }));

  test('the priced (invoice-holding) row itself moving off the sibling\'s date raises the same alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.pestId }).update({ scheduled_date: '2026-10-05' });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.pestId);
    expect(result.action).toBe('alert_raised');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('a recurring child\'s own date is unrelated to the accept-time split — skipped', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const childId = randomUUID();
    await trx('scheduled_services').insert({
      id: childId, customer_id: ids.customerId, source_estimate_id: ids.estimateId,
      recurring_parent_id: ids.lawnId, scheduled_date: '2026-11-01',
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null,
    });
    const result = await flagFirstApplicationSiblingDivergence(trx, childId);
    expect(result).toEqual({ action: 'skipped', reason: 'not_estimate_anchor' });
  }));

  test('no source_estimate_id at all — skipped', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'No estimate fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true });
    const soloId = randomUUID();
    await trx('scheduled_services').insert({
      id: soloId, customer_id: customerId, scheduled_date: '2026-10-01',
      service_type: 'One-time visit', status: 'confirmed', estimated_price: 100,
    });
    const result = await flagFirstApplicationSiblingDivergence(trx, soloId);
    expect(result).toEqual({ action: 'skipped', reason: 'not_estimate_anchor' });
  }));

  test('no priced member in the group at all — skipped', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { noInvoice: true });
    await trx('scheduled_services').where({ id: ids.pestId }).update({ estimated_price: null });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const result = await flagFirstApplicationSiblingDivergence(trx, ids.lawnId);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('no_priced_anchor');
  }));

  test('an alert-write failure rolls back the whole move — no date change, no partial alert', async () => {
    const spy = jest.spyOn(notificationService, 'notifyAdmin').mockRejectedValueOnce(new Error('injected notifyAdmin failure'));
    let ids;
    try {
      await expect(db.transaction(async (trx) => {
        ids = await fixture(trx);
        await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
        await flagFirstApplicationSiblingDivergenceSafely(trx, ids.lawnId, 'injected-failure test');
      })).rejects.toThrow('injected notifyAdmin failure');
    } finally {
      spy.mockRestore();
    }
    // Nothing committed — not even the fixture rows themselves, since the
    // date write and the alert share the SAME transaction as the fixture
    // insert in this test.
    expect(await db('scheduled_services').where({ id: ids.lawnId }).first()).toBeUndefined();
  });
});
