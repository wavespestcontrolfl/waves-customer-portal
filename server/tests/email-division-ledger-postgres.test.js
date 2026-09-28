/**
 * marketing_email_ledger / reserveWithCap — real PostgreSQL concurrency
 * check. The per-customer pg_advisory_xact_lock must serialize concurrent
 * reservation attempts (genuine separate pool connections, not mocked): a
 * SAME idempotency key dedupes to one row; DIFFERENT keys for the same
 * customer+stream may not both stay outstanding at once; and the stored
 * recipient is always the customer's own checked email, never a caller
 * value.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('email-division ledger (Postgres)', () => {
  jest.setTimeout(30000);
  let db;
  let Ledger;
  let Eligibility;
  let customerId;
  let customerEmail;

  beforeAll(() => {
    db = require('../models/db');
    Ledger = require('../services/email-division/ledger');
    Eligibility = require('../services/email-division/eligibility');
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    customerId = randomUUID();
    customerEmail = `${customerId}@example.invalid`;
    await db('customers').insert({
      id: customerId,
      first_name: 'Synthetic', last_name: 'EmailDivision',
      phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      email: customerEmail,
      active: true,
    });
    await db('notification_prefs').insert({
      customer_id: customerId, email_enabled: true, marketing_offers: true,
    });
  });

  afterEach(async () => {
    await db('marketing_email_ledger').where({ customer_id: customerId }).del();
    await db('notification_prefs').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
  });

  function attempt(idempotencyKey, overrides = {}) {
    return Ledger.reserveWithCap({
      customerId, stream: 'broadcast', marketingClass: 'marketing',
      emailKey: 'mkt.broadcast.weekly', idempotencyKey, now: new Date(), ...overrides,
    });
  }

  test('two concurrent reservations on the same idempotency key dedupe under the advisory lock, and a sent cap then blocks a later attempt', async () => {
    // Genuine concurrency: two separate pool connections race for the same
    // per-customer advisory lock on the SAME idempotency key.
    const [a, b] = await Promise.all([attempt('race-key'), attempt('race-key')]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const duplicates = [a, b].filter((r) => r.duplicate);
    const fresh = [a, b].filter((r) => !r.duplicate);
    expect(duplicates).toHaveLength(1);
    expect(fresh).toHaveLength(1);
    expect(duplicates[0].row.id).toBe(fresh[0].row.id);
    // The recipient stored is always the customer's own checked email, never
    // a caller-supplied value (codex pre-push r1 P1).
    expect(fresh[0].row.recipient_email).toBe(customerEmail);

    const rows = await db('marketing_email_ledger').where({ customer_id: customerId });
    expect(rows).toHaveLength(1); // the ON CONFLICT DO NOTHING left exactly one row

    // Mark the winning reservation delivered, then a second, distinct
    // broadcast attempt this week is denied by the weekly cap.
    await Ledger.markSent(fresh[0].row.id, { emailMessageId: null });
    const second = await attempt('second-key');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe(Eligibility.REASONS.CAP_WEEKLY_BROADCAST);
    expect(second.row).toBeNull();

    const finalRows = await db('marketing_email_ledger').where({ customer_id: customerId });
    expect(finalRows).toHaveLength(1); // the capped attempt never inserted
  });

  test('two concurrent reservations with DIFFERENT idempotency keys: only one may stay outstanding at once (codex pre-push r1 P1)', async () => {
    // Neither attempt has been marked sent yet — eligibleForEmail's own caps
    // (which read only `sent` rows) would let BOTH through; the in-flight
    // `reserved`-row check inside reserveWithCap is what must catch this.
    const [a, b] = await Promise.all([attempt('key-a'), attempt('key-b')]);
    const oks = [a, b].filter((r) => r.ok);
    const capped = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(capped).toHaveLength(1);
    expect(capped[0].reason).toBe(Eligibility.REASONS.CAP_WEEKLY_BROADCAST);
    expect(capped[0].row).toBeNull();

    const rows = await db('marketing_email_ledger').where({ customer_id: customerId });
    expect(rows).toHaveLength(1); // only the winner's reservation exists
  });
});
