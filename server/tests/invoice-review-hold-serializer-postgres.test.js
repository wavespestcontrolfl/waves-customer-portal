/**
 * The Send modal's "parked" state must read the SERVER's own predicate
 * (isStaleClaimReviewHold), never a client-side guess at scheduled_send_error's
 * text (fourth audit gap #4131). This suite proves the ONE place that
 * predicate is wired into both invoice serializers InvoiceService.getById
 * (single-invoice GET, backing SendInvoiceModal when opened directly) and
 * InvoiceService.list (the invoices list GET, backing the list's own rows) —
 * both must carry `review_hold` computed from the SAME helper, and a row
 * whose scheduled_send_error is unrelated to the stale-claim park (e.g. a
 * provider phone-number rejection) must read review_hold: false even though
 * it too sits at status 'scheduled' with scheduled_send_at cleared.
 *
 * DB-backed (self-skips without DATABASE_URL, same convention as
 * invoice-getbyid-card-on-file.test.js).
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('InvoiceService.getById / .list — review_hold serializer field (fourth audit gap #4131)', () => {
  const db = require('../models/db');
  const InvoiceService = require('../services/invoice');
  const { STALE_SEND_PARK_ERROR } = require('../services/invoice-helpers');
  const tag = `rhold-${Date.now().toString(36)}`;
  let customerId;
  let parkedId;
  let unrelatedId;

  beforeAll(async () => {
    [{ id: customerId }] = await db('customers')
      .insert({
        first_name: 'ReviewHold',
        last_name: tag,
        email: `${tag}@example.test`,
        phone: '+19410000000',
      })
      .returning('id');
    [{ id: parkedId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}-parked`,
        token: `tok-${tag}-parked`,
        title: 'review_hold parked regression',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'scheduled',
        scheduled_send_at: null,
        scheduled_send_error: STALE_SEND_PARK_ERROR,
      })
      .returning('id');
    [{ id: unrelatedId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}-unrelated`,
        token: `tok-${tag}-unrelated`,
        title: 'review_hold unrelated-error regression',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'scheduled',
        scheduled_send_at: null,
        // A scheduled row CAN carry a send error that has nothing to do
        // with the stale-claim review hold (a provider rejection on a
        // retry attempt, say) — review_hold must stay false for it.
        scheduled_send_error: 'Twilio rejected: invalid phone number',
      })
      .returning('id');
  });

  afterAll(async () => {
    if (parkedId) await db('invoices').where({ id: parkedId }).del();
    if (unrelatedId) await db('invoices').where({ id: unrelatedId }).del();
    if (customerId) await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  test('getById: a parked row carries review_hold: true; an unrelated-error row carries review_hold: false', async () => {
    const parked = await InvoiceService.getById(parkedId);
    expect(parked.review_hold).toBe(true);
    const unrelated = await InvoiceService.getById(unrelatedId);
    expect(unrelated.review_hold).toBe(false);
  });

  test('list: the SAME two rows carry the SAME review_hold values as getById', async () => {
    const { invoices } = await InvoiceService.list({ customerId, limit: 10 });
    const parkedRow = invoices.find((i) => i.id === parkedId);
    const unrelatedRow = invoices.find((i) => i.id === unrelatedId);
    expect(parkedRow.review_hold).toBe(true);
    expect(unrelatedRow.review_hold).toBe(false);
  });
});
