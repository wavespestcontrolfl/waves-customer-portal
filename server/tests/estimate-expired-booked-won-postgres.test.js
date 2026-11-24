/**
 * Expired estimates whose customer later booked count as WON — real migrated
 * Postgres, the real reclaim query (estimate-conversion-guard.js).
 *
 * Owner request 2026-11-24: an estimate that expired before its customer's
 * first-ever paid invoice or completed visit is a win routed around the
 * estimate. The daily pass stamps converted_other_path and nothing else.
 *
 * Needs DATABASE_URL pointing at a local, migrated, disposable database.
 * Every fixture rolls back; all data is synthetic.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
if (!SKIP && !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('estimate-expired-booked-won-postgres requires a local database.');
}

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  database.fn = { now: () => new Date() };
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const dateOnly = (d) => d.toISOString().slice(0, 10);

// The estimate went out 150 days ago and expired 143 days ago.
const SENT_DAYS_AGO = 150;
const sentPlus = (n) => daysAgo(SENT_DAYS_AGO - n);

postgres('expired estimate reclaim — booked after expiry counts as won', () => {
  let db;
  let guard;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    guard = require('../services/estimate-conversion-guard');
  });

  beforeEach(async () => { mockTransaction = await db.transaction(); });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  async function customer(trx) {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await trx('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: 'Reclaimlane',
      phone: `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`,
      email: `qa-${tag}@example.test`,
      active: true,
      address_line1: '123 Synthetic Ave',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    });
    return id;
  }

  async function expiredEstimate(trx, customerId, overrides = {}) {
    const id = randomUUID();
    await trx('estimates').insert({
      id,
      customer_id: customerId,
      status: 'expired',
      token: randomUUID().replace(/-/g, ''),
      customer_name: 'Synthetic Reclaimlane',
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 0,
      estimate_data: JSON.stringify({}),
      sent_at: daysAgo(SENT_DAYS_AGO),
      created_at: daysAgo(SENT_DAYS_AGO),
      expires_at: daysAgo(SENT_DAYS_AGO - 7),
      disposition: 'expired_viewed',
      disposition_source: 'system',
      disposition_at: daysAgo(SENT_DAYS_AGO - 7),
      ...overrides,
    });
    return id;
  }

  async function paidInvoice(trx, customerId, { paidAt, createdAt = paidAt }) {
    await trx('invoices').insert({
      customer_id: customerId,
      token: randomUUID().replace(/-/g, ''),
      invoice_number: `QA-${randomUUID().slice(0, 8)}`,
      status: 'paid',
      paid_at: paidAt,
      created_at: createdAt,
    });
  }

  async function completedVisit(trx, customerId, completedAt, createdAt = completedAt) {
    const paid = await trx('services').whereNot({ service_key: 'lawn_inspection' }).first('id');
    await trx('scheduled_services').insert({
      id: randomUUID(),
      customer_id: customerId,
      service_id: paid.id,
      service_type: 'Lawn Care',
      scheduled_date: dateOnly(completedAt),
      window_start: '09:00',
      window_end: '11:00',
      status: 'completed',
      completed_at: completedAt,
      created_at: createdAt,
    });
  }

  const row = (id) => mockTransaction('estimates').where({ id }).first();

  test('(a) first-ever payment inside 90 days of sent_at stamps the win and nothing else', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust);
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(30) });
    const before = await row(id);

    const res = await guard.reclaimExpiredConvertedEstimates();

    expect(res.rows.map((r) => r.id)).toContain(id);
    const after = await row(id);
    expect(after.disposition).toBe('converted_other_path');
    expect(after.disposition_source).toBe('system');
    expect(new Date(after.disposition_at).getTime()).toBeGreaterThan(new Date(before.disposition_at).getTime());
    // Lifecycle fields are untouched: it stays expired, un-archived.
    expect(after.status).toBe('expired');
    expect(after.archived_at).toBeNull();
    // updated_at stays (a NULL-expires_at row would resolve by it).
    expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
    expect(new Date(after.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
    expect(after.sent_at.getTime()).toBe(before.sent_at.getTime());
  });

  test('(b) a completed paid visit inside the window stamps it, and a second run is a no-op', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust, { disposition: null, disposition_source: null, disposition_at: null });
    await completedVisit(mockTransaction, cust, sentPlus(60), sentPlus(45));

    expect((await guard.reclaimExpiredConvertedEstimates()).rows.map((r) => r.id)).toContain(id);
    expect((await row(id)).disposition).toBe('converted_other_path');
    expect((await guard.reclaimExpiredConvertedEstimates()).rows.map((r) => r.id)).not.toContain(id);
  });

  test('(c) day 89 counts, day 120 does not', async () => {
    const early = await customer(mockTransaction);
    const earlyId = await expiredEstimate(mockTransaction, early, { disposition: 'expired_unviewed' });
    await paidInvoice(mockTransaction, early, { paidAt: sentPlus(89) });
    const late = await customer(mockTransaction);
    const lateId = await expiredEstimate(mockTransaction, late);
    await paidInvoice(mockTransaction, late, { paidAt: sentPlus(120) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(earlyId)).disposition).toBe('converted_other_path');
    expect((await row(lateId)).disposition).toBe('expired_viewed');
  });

  test('(d) a customer who converted BEFORE the estimate is left alone', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust);
    await paidInvoice(mockTransaction, cust, { paidAt: daysAgo(SENT_DAYS_AGO + 40) });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(20) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(id)).disposition).toBe('expired_viewed');
  });

  test('(e) a staff or customer disposition, an unsent draft and an archived row are untouched', async () => {
    const staffCust = await customer(mockTransaction);
    const staffId = await expiredEstimate(mockTransaction, staffCust, { disposition: 'declined_price', disposition_source: 'staff' });
    await paidInvoice(mockTransaction, staffCust, { paidAt: sentPlus(10) });

    const declinedCust = await customer(mockTransaction);
    const declinedId = await expiredEstimate(mockTransaction, declinedCust, { disposition: 'declined_by_customer', disposition_source: 'customer' });
    await paidInvoice(mockTransaction, declinedCust, { paidAt: sentPlus(10) });

    const unsentCust = await customer(mockTransaction);
    const unsentId = await expiredEstimate(mockTransaction, unsentCust, { disposition: 'expired_unsent' });
    await paidInvoice(mockTransaction, unsentCust, { paidAt: sentPlus(10) });

    const archivedCust = await customer(mockTransaction);
    const archivedId = await expiredEstimate(mockTransaction, archivedCust, { archived_at: daysAgo(100) });
    await paidInvoice(mockTransaction, archivedCust, { paidAt: sentPlus(10) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(staffId)).disposition).toBe('declined_price');
    expect((await row(declinedId)).disposition).toBe('declined_by_customer');
    expect((await row(unsentId)).disposition).toBe('expired_unsent');
    expect((await row(archivedId)).disposition).toBe('expired_viewed');
  });

  test('(g) the FIRST signal must land after delivery: a payment between creation and delivery blocks it', async () => {
    const early = await customer(mockTransaction);
    const earlyId = await expiredEstimate(mockTransaction, early, { sent_at: daysAgo(SENT_DAYS_AGO - 10) });
    await paidInvoice(mockTransaction, early, { paidAt: daysAgo(SENT_DAYS_AGO - 5) });
    // Control: the same shape with the payment after delivery is reclaimed.
    const ok = await customer(mockTransaction);
    const okId = await expiredEstimate(mockTransaction, ok, { sent_at: daysAgo(SENT_DAYS_AGO - 10) });
    await paidInvoice(mockTransaction, ok, { paidAt: daysAgo(SENT_DAYS_AGO - 20) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(earlyId)).disposition).toBe('expired_viewed');
    expect((await row(okId)).disposition).toBe('converted_other_path');
  });

  test('(h) self-serve quotes: undelivered never qualifies; delivered is windowed from firstDeliveredAt, not the mint stamp', async () => {
    const mint = daysAgo(SENT_DAYS_AGO);
    const delivered = (daysFromMint) => JSON.stringify({ deliveryState: { firstDeliveredAt: sentPlus(daysFromMint).toISOString() } });

    const undeliveredCust = await customer(mockTransaction);
    const undeliveredId = await expiredEstimate(mockTransaction, undeliveredCust, { source: 'plan_start', sent_at: mint });
    await paidInvoice(mockTransaction, undeliveredCust, { paidAt: sentPlus(30) });

    // Paid 20 days after the mint but 20 days BEFORE the real delivery (day 40).
    const beforeCust = await customer(mockTransaction);
    const beforeId = await expiredEstimate(mockTransaction, beforeCust, { source: 'plan_start', sent_at: mint, estimate_data: delivered(40) });
    await paidInvoice(mockTransaction, beforeCust, { paidAt: sentPlus(20) });

    // Paid 100 days after the mint: past 90 days of the mint, inside 90 of the real delivery (day 40).
    const afterCust = await customer(mockTransaction);
    const afterId = await expiredEstimate(mockTransaction, afterCust, { source: 'plan_start', sent_at: mint, estimate_data: delivered(40) });
    await paidInvoice(mockTransaction, afterCust, { paidAt: sentPlus(100) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(undeliveredId)).disposition).toBe('expired_viewed');
    expect((await row(beforeId)).disposition).toBe('expired_viewed');
    expect((await row(afterId)).disposition).toBe('converted_other_path');
  });

  test('(i) the win is dated by the customer\'s EARLIEST signal, not the day the pass ran, so cohorts read it right', async () => {
    const { _private } = require('../services/estimate-winloss');
    const cust = await customer(mockTransaction);
    // Sent 35 days ago, expired at day 6; paid at day 10; reclaimed today (day 35).
    const sent = daysAgo(35);
    const id = await expiredEstimate(mockTransaction, cust, {
      sent_at: sent, created_at: daysAgo(36), expires_at: daysAgo(29), disposition_at: daysAgo(29),
    });
    await paidInvoice(mockTransaction, cust, { paidAt: daysAgo(25) });
    // A later payment must not move the date.
    await paidInvoice(mockTransaction, cust, { paidAt: daysAgo(5) });

    await guard.reclaimExpiredConvertedEstimates();

    const after = await row(id);
    expect(Math.abs(new Date(after.disposition_at).getTime() - daysAgo(25).getTime())).toBeLessThan(60 * 1000);
    const cohorts = _private.sentCohorts([after], { days: 30, nowMs: Date.now() }).cohorts;
    const at = (m) => cohorts.find((c) => c.maturityDays === m);
    expect(at(7)).toMatchObject({ sent: 1, won: 0, lost: 1 });
    expect(at(14)).toMatchObject({ sent: 1, won: 1, lost: 0 });
    expect(at(30)).toMatchObject({ sent: 1, won: 1, lost: 0 });
  });

  test('(j) a resend rewrites sent_at, but the window runs from the first delivery: resend day 80 + pay day 120 is not reclaimed', async () => {
    const stamp = (days) => JSON.stringify({ deliveryState: { firstDeliveredAt: sentPlus(days).toISOString() } });
    // First delivered day 0, resent day 80 (sent_at overwritten), paid day 120.
    const resentCust = await customer(mockTransaction);
    const resentId = await expiredEstimate(mockTransaction, resentCust, { sent_at: sentPlus(80), estimate_data: stamp(0) });
    await paidInvoice(mockTransaction, resentCust, { paidAt: sentPlus(120) });
    // No stamp (older row): the first view bounds the first delivery.
    const viewedCust = await customer(mockTransaction);
    const viewedId = await expiredEstimate(mockTransaction, viewedCust, { sent_at: sentPlus(80), viewed_at: sentPlus(5) });
    await paidInvoice(mockTransaction, viewedCust, { paidAt: sentPlus(120) });
    // The same resend with the stamp in the staff timestamp shape sentAnchorMs reads ('… 12:00:00.000+00').
    const spacedCust = await customer(mockTransaction);
    const spaced = sentPlus(0).toISOString().replace('T', ' ').replace('Z', '+00');
    const spacedId = await expiredEstimate(mockTransaction, spacedCust, {
      sent_at: sentPlus(80), estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: spaced } }),
    });
    await paidInvoice(mockTransaction, spacedCust, { paidAt: sentPlus(120) });
    // Control: resent day 80, paid day 60 (inside 90 days of the first delivery).
    const okCust = await customer(mockTransaction);
    const okId = await expiredEstimate(mockTransaction, okCust, { sent_at: sentPlus(80), estimate_data: stamp(0) });
    await paidInvoice(mockTransaction, okCust, { paidAt: sentPlus(85) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(resentId)).disposition).toBe('expired_viewed');
    expect((await row(viewedId)).disposition).toBe('expired_viewed');
    expect((await row(spacedId)).disposition).toBe('expired_viewed');
    expect((await row(okId)).disposition).toBe('converted_other_path');
  });

  test('(k) one payment wins ONE offer: of two expired quotes only the latest delivered before it', async () => {
    const cust = await customer(mockTransaction);
    const older = await expiredEstimate(mockTransaction, cust, { sent_at: sentPlus(0), created_at: sentPlus(0) });
    const newer = await expiredEstimate(mockTransaction, cust, { sent_at: sentPlus(30), created_at: sentPlus(30), expires_at: sentPlus(37) });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(50) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(older)).disposition).toBe('expired_viewed');
    expect((await row(newer)).disposition).toBe('converted_other_path');
    // A second run does not pick the older one up either (the sale is spoken for).
    await guard.reclaimExpiredConvertedEstimates();
    expect((await row(older)).disposition).toBe('expired_viewed');
  });

  test('(l) an accepted replacement estimate, or an offer sent after the payment started, means no reclaim', async () => {
    const acceptedCust = await customer(mockTransaction);
    const expiredId = await expiredEstimate(mockTransaction, acceptedCust);
    await expiredEstimate(mockTransaction, acceptedCust, { status: 'accepted', accepted_at: sentPlus(40), disposition: null, disposition_source: null, disposition_at: null, sent_at: sentPlus(30), created_at: sentPlus(30) });
    await paidInvoice(mockTransaction, acceptedCust, { paidAt: sentPlus(50) });

    // A delivered LATER quote that is not expired (declined) is the offer the payment belongs to: ambiguous, stays lost.
    const declinedCust = await customer(mockTransaction);
    const earlierId = await expiredEstimate(mockTransaction, declinedCust);
    await expiredEstimate(mockTransaction, declinedCust, { status: 'declined', disposition: 'declined_price', disposition_source: 'staff', sent_at: sentPlus(30), created_at: sentPlus(30) });
    await paidInvoice(mockTransaction, declinedCust, { paidAt: sentPlus(50) });

    // Control: a quote delivered AFTER the first signal does not make the earlier one ambiguous.
    const lateCust = await customer(mockTransaction);
    const firstId = await expiredEstimate(mockTransaction, lateCust);
    await expiredEstimate(mockTransaction, lateCust, { status: 'sent', expires_at: null, disposition: null, disposition_source: null, disposition_at: null, sent_at: sentPlus(70), created_at: sentPlus(70) });
    await paidInvoice(mockTransaction, lateCust, { paidAt: sentPlus(50) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(expiredId)).disposition).toBe('expired_viewed');
    expect((await row(earlierId)).disposition).toBe('expired_viewed');
    expect((await row(firstId)).disposition).toBe('converted_other_path');
  });

  test('(m) delivery evidence is enough: a viewed-only row (no sent_at) paid inside the window is reclaimed', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust, { sent_at: null, viewed_at: sentPlus(5) });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(30) });
    // Nothing delivered at all (no sent_at, no view, no stamp): never reclaimed.
    const undelivered = await customer(mockTransaction);
    const undeliveredId = await expiredEstimate(mockTransaction, undelivered, { sent_at: null });
    await paidInvoice(mockTransaction, undelivered, { paidAt: sentPlus(30) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(id)).disposition).toBe('converted_other_path');
    expect((await row(undeliveredId)).disposition).toBe('expired_viewed');
  });

  test('(n) an offer accepted months AFTER the payment does not block; one accepted at or before it does', async () => {
    const upsellCust = await customer(mockTransaction);
    const upsellQuoteId = await expiredEstimate(mockTransaction, upsellCust);
    await expiredEstimate(mockTransaction, upsellCust, { status: 'accepted', accepted_at: sentPlus(150), disposition: null, disposition_source: null, disposition_at: null, sent_at: sentPlus(140), created_at: sentPlus(140) });
    await paidInvoice(mockTransaction, upsellCust, { paidAt: sentPlus(50) });

    const earlyCust = await customer(mockTransaction);
    const earlyQuoteId = await expiredEstimate(mockTransaction, earlyCust);
    await expiredEstimate(mockTransaction, earlyCust, { status: 'accepted', accepted_at: sentPlus(40), disposition: null, disposition_source: null, disposition_at: null, sent_at: sentPlus(30), created_at: sentPlus(30) });
    await paidInvoice(mockTransaction, earlyCust, { paidAt: sentPlus(50) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(upsellQuoteId)).disposition).toBe('converted_other_path');
    expect((await row(earlyQuoteId)).disposition).toBe('expired_viewed');
  });

  test('(o) an accepted offer with NO accepted_at blocks only if it was created at or before the first signal', async () => {
    const accepted = { status: 'accepted', accepted_at: null, disposition: null, disposition_source: null, disposition_at: null };
    const laterCust = await customer(mockTransaction);
    const laterQuoteId = await expiredEstimate(mockTransaction, laterCust);
    await expiredEstimate(mockTransaction, laterCust, { ...accepted, sent_at: sentPlus(140), created_at: sentPlus(140) });
    await paidInvoice(mockTransaction, laterCust, { paidAt: sentPlus(50) });

    const earlierCust = await customer(mockTransaction);
    const earlierQuoteId = await expiredEstimate(mockTransaction, earlierCust);
    await expiredEstimate(mockTransaction, earlierCust, { ...accepted, sent_at: sentPlus(20), created_at: sentPlus(20) });
    await paidInvoice(mockTransaction, earlierCust, { paidAt: sentPlus(50) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(laterQuoteId)).disposition).toBe('converted_other_path');
    expect((await row(earlierQuoteId)).disposition).toBe('expired_viewed');
  });

  test('(p) a booking made between the draft and its send was not caused by the quote: draft -> booking -> send -> completion is not reclaimed', async () => {
    const early = await customer(mockTransaction);
    // Created day 0, sent day 10; the visit was booked day 5 and completed day 30.
    const earlyId = await expiredEstimate(mockTransaction, early, { sent_at: sentPlus(10) });
    await completedVisit(mockTransaction, early, sentPlus(30), sentPlus(5));
    // Control: booked day 15, after the send, completed day 30.
    const ok = await customer(mockTransaction);
    const okId = await expiredEstimate(mockTransaction, ok, { sent_at: sentPlus(10) });
    await completedVisit(mockTransaction, ok, sentPlus(30), sentPlus(15));

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(earlyId)).disposition).toBe('expired_viewed');
    expect((await row(okId)).disposition).toBe('converted_other_path');
  });

  test('(q) two offers delivered at the SAME instant compete: neither is reclaimed', async () => {
    const cust = await customer(mockTransaction);
    const same = sentPlus(0); // one Date: the two offers share the exact instant
    const a = await expiredEstimate(mockTransaction, cust, { sent_at: same });
    const b = await expiredEstimate(mockTransaction, cust, { sent_at: same });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(30) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(a)).disposition).toBe('expired_viewed');
    expect((await row(b)).disposition).toBe('expired_viewed');
  });

  test('(r) a staff quote with a PRESENT but unzoned firstDeliveredAt has no usable anchor: it never falls back to sent_at, so it is not reclaimed', async () => {
    const unzoned = sentPlus(0).toISOString().replace('T', ' ').replace('Z', ''); // '2026-.. 12:00:00.000', no zone
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust, {
      sent_at: sentPlus(0), estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: unzoned } }),
    });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(30) });
    // Control: the same row with no stamp at all is reclaimed.
    const plain = await customer(mockTransaction);
    const plainId = await expiredEstimate(mockTransaction, plain, { sent_at: sentPlus(0) });
    await paidInvoice(mockTransaction, plain, { paidAt: sentPlus(30) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(id)).disposition).toBe('expired_viewed');
    expect((await row(plainId)).disposition).toBe('converted_other_path');
  });

  test('(f) a live sent estimate is not this pass\'s business (the archive sweep owns it)', async () => {
    const cust = await customer(mockTransaction);
    const id = await expiredEstimate(mockTransaction, cust, { status: 'sent', expires_at: null, disposition: null, disposition_source: null, disposition_at: null });
    await paidInvoice(mockTransaction, cust, { paidAt: sentPlus(10) });

    await guard.reclaimExpiredConvertedEstimates();

    expect((await row(id)).disposition).toBeNull();
  });
});
