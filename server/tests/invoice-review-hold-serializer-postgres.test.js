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
    // db.destroy() happens ONCE, in the second describe below — both
    // blocks share this file's single required `db` connection pool, and
    // destroying it here would strand the second block's own beforeAll.
    if (parkedId) await db('invoices').where({ id: parkedId }).del();
    if (unrelatedId) await db('invoices').where({ id: unrelatedId }).del();
    if (customerId) await db('customers').where({ id: customerId }).del();
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

/**
 * Round-3 P2 (PR #4633, commit ba77bf88e5): claimInvoiceForSend's atomic
 * flip carries the review-hold guard as a real PostgreSQL WHERE predicate —
 * `NOT (status = 'scheduled' AND scheduled_send_at IS NULL AND
 * COALESCE(scheduled_send_error, '') LIKE ?)`. Before the COALESCE, a
 * scheduled row with NO scheduled_send_error at all made the LIKE (and so
 * the whole NOT) evaluate to SQL NULL, and PostgreSQL only matches WHERE on
 * TRUE — never NULL — so the flip's UPDATE touched zero rows and EVERY
 * send on such a row failed as "not sendable", even though it was never
 * parked. This suite proves the real predicate against a real PostgreSQL
 * connection, not a mock.
 */
describeOrSkip('claimInvoiceForSend — the atomic flip predicate against real PostgreSQL (round-3 P2, PR #4633)', () => {
  const db = require('../models/db');
  const { claimInvoiceForSend } = require('../services/invoice');
  const { STALE_SEND_PARK_ERROR } = require('../services/invoice-helpers');
  const tag = `rhold-flip-${Date.now().toString(36)}`;
  let customerId;
  let noErrorId;
  let parkedId;

  beforeAll(async () => {
    [{ id: customerId }] = await db('customers')
      .insert({
        first_name: 'ReviewHoldFlip',
        last_name: tag,
        email: `${tag}@example.test`,
        phone: '+19410000001',
      })
      .returning('id');
    // A scheduled, never-parked row with NO scheduled_send_error at all —
    // the exact shape the pre-COALESCE predicate could never claim.
    [{ id: noErrorId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}-noerror`,
        token: `tok-${tag}-noerror`,
        title: 'review_hold flip NULL-error regression',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'scheduled',
        scheduled_send_at: null,
        scheduled_send_error: null,
      })
      .returning('id');
    [{ id: parkedId }] = await db('invoices')
      .insert({
        customer_id: customerId,
        invoice_number: `T-${tag}-parked`,
        token: `tok-${tag}-parked`,
        title: 'review_hold flip parked regression',
        line_items: JSON.stringify([]),
        subtotal: 10,
        total: 10,
        status: 'scheduled',
        scheduled_send_at: null,
        scheduled_send_error: STALE_SEND_PARK_ERROR,
      })
      .returning('id');
  });

  afterAll(async () => {
    if (noErrorId) await db('invoices').where({ id: noErrorId }).del();
    if (parkedId) await db('invoices').where({ id: parkedId }).del();
    if (customerId) await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  test('a scheduled row with scheduled_send_error NULL (never parked) IS claimed — flips to sending with a token', async () => {
    const result = await claimInvoiceForSend(noErrorId, { firstDeliveryOnly: true });
    expect(result.claimed).toBe(true);
    expect(result.invoice.status).toBe('sending');
    expect(result.invoice.send_claim_token).toEqual(expect.any(String));
    const row = await db('invoices').where({ id: noErrorId }).first('status', 'send_claim_token');
    expect(row.status).toBe('sending');
    expect(row.send_claim_token).toBe(result.invoice.send_claim_token);
  });

  test('a parked row is refused with the stale-claim review hold error', async () => {
    await expect(claimInvoiceForSend(parkedId, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
    const row = await db('invoices').where({ id: parkedId }).first('status');
    expect(row.status).toBe('scheduled');
  });
});
