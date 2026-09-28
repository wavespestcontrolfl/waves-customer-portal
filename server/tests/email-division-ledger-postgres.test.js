/**
 * marketing_email_ledger / reserveWithCap — real PostgreSQL concurrency
 * check. The per-customer pg_advisory_xact_lock must serialize two truly
 * concurrent reservation attempts (genuine separate pool connections, not
 * mocked), so exactly one wins the unique idempotency key and a later,
 * separately-keyed attempt is correctly capped once the winner is sent.
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
    await db('customers').insert({
      id: customerId,
      first_name: 'Synthetic', last_name: 'EmailDivision',
      phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      email: `${customerId}@example.invalid`,
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

  test('two concurrent reservations on the same idempotency key dedupe under the advisory lock, and a sent cap then blocks a later attempt', async () => {
    const now = new Date();
    const attempt = (idempotencyKey) => Ledger.reserveWithCap({
      customerId,
      stream: 'broadcast',
      marketingClass: 'marketing',
      emailKey: 'mkt.broadcast.weekly',
      idempotencyKey,
      recipientEmail: 'synthetic@example.invalid',
      now,
    });

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
});
