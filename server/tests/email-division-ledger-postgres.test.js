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

  test('markSent racing a distinct concurrent reservation attempt never lets both through (codex pre-push r3 P1)', async () => {
    const first = await attempt('first-key');
    expect(first.ok).toBe(true);

    // markSent takes the SAME per-customer lock reserveWithCap does, so
    // whichever transaction gets it first runs to completion before the
    // other's checks can even begin — no split-read window between the
    // eligibility (`sent` rows) and outstanding-reservation (`reserved`
    // rows) queries. Every ordering must still deny the second attempt:
    // either it sees the row still `reserved` (outstanding conflict) or
    // already `sent` (weekly cap) — never neither.
    const [, second] = await Promise.all([
      Ledger.markSent(first.row.id, { emailMessageId: null }),
      attempt('second-key'),
    ]);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe(Eligibility.REASONS.CAP_WEEKLY_BROADCAST);
    expect(second.row).toBeNull();

    const rows = await db('marketing_email_ledger').where({ customer_id: customerId });
    expect(rows).toHaveLength(1); // the racing attempt never inserted
    expect(rows[0].status).toBe('sent');
  });

  test('GitHub round P1: a stale reservation whose key email_messages shows as accepted completes as SENT, links the message, and keeps counting toward the cap', async () => {
    const first = await attempt('accepted-key');
    expect(first.ok).toBe(true);
    const [message] = await db('email_messages').insert({
      idempotency_key: 'accepted-key', recipient_email_snapshot: customerEmail, recipient_type: 'customer', recipient_id: customerId,
      template_key: 'mkt.broadcast.weekly', status: 'sent', sent_at: new Date(), provider_message_id: 'sg-synthetic-1',
    }).returning(['id']);
    try {
      // Backdate the reservation past the sweep's lifetime, as a crash after
      // provider acceptance but before markSent would leave it.
      await db('marketing_email_ledger').where({ idempotency_key: 'accepted-key' })
        .update({ reserved_at: new Date(Date.now() - 45 * 60 * 1000) });

      const second = await attempt('next-key');

      const reconciled = await db('marketing_email_ledger').where({ idempotency_key: 'accepted-key' }).first();
      expect(reconciled.status).toBe('sent');
      expect(reconciled.email_message_id).toBe(message.id);
      expect(reconciled.reason).toBe('reconciled_from_email_messages');
      expect(reconciled.sent_at).not.toBeNull();
      // The delivered email counts: the weekly broadcast cap denies the next one.
      expect(second.ok).toBe(false);
      expect(second.reason).toBe(Eligibility.REASONS.CAP_WEEKLY_BROADCAST);
    } finally {
      await db('email_messages').where({ id: message.id }).del();
    }
  });

  test('GitHub round P1: a handoff that STARTED with no acceptance recorded (worker died mid-response) is counted as sent, not abandoned', async () => {
    const first = await attempt('uncertain-key');
    const [message] = await db('email_messages').insert({
      idempotency_key: 'uncertain-key', recipient_email_snapshot: customerEmail, recipient_type: 'customer', recipient_id: customerId,
      template_key: 'mkt.broadcast.weekly', status: 'queued', provider_handoff_phase: 'started',
    }).returning(['id']);
    try {
      await db('marketing_email_ledger').where({ idempotency_key: 'uncertain-key' })
        .update({ reserved_at: new Date(Date.now() - 45 * 60 * 1000) });
      const second = await attempt('after-uncertain');
      const row = await db('marketing_email_ledger').where({ id: first.row.id }).first();
      expect(row.status).toBe('sent');
      expect(row.reason).toBe('provider_handoff_uncertain');
      expect(row.email_message_id).toBe(message.id);
      expect(second.ok).toBe(false);
      expect(second.reason).toBe(Eligibility.REASONS.CAP_WEEKLY_BROADCAST);
    } finally {
      await db('email_messages').where({ id: message.id }).del();
    }
  });

  test('GitHub round P1: a handoff SendGrid rejected settles as failed/provider_rejected and frees the cap', async () => {
    const first = await attempt('rejected-key');
    const [message] = await db('email_messages').insert({
      idempotency_key: 'rejected-key', recipient_email_snapshot: customerEmail, recipient_type: 'customer', recipient_id: customerId,
      template_key: 'mkt.broadcast.weekly', status: 'failed', provider_handoff_phase: 'rejected', error_message: 'synthetic 400',
    }).returning(['id']);
    try {
      await db('marketing_email_ledger').where({ idempotency_key: 'rejected-key' })
        .update({ reserved_at: new Date(Date.now() - 45 * 60 * 1000) });
      const second = await attempt('after-rejected');
      const row = await db('marketing_email_ledger').where({ id: first.row.id }).first();
      expect(row.status).toBe('failed');
      expect(row.reason).toBe('provider_rejected');
      expect(second.ok).toBe(true);
    } finally {
      await db('email_messages').where({ id: message.id }).del();
    }
  });

  test('GitHub round P1: markSent promotes a FAILED row after a same-key provider retry succeeded, and the sweep does the same from email_messages', async () => {
    const first = await attempt('retry-key');
    expect(await Ledger.markFailed(first.row.id, 'provider_rejected')).toBe(true);
    // The library retries the same key and SendGrid accepts it this time.
    expect(await Ledger.markSent(first.row.id, { emailMessageId: null })).toBe(1);
    expect((await db('marketing_email_ledger').where({ id: first.row.id }).first()).status).toBe('sent');

    // Nobody called markSent for this one; the sweep finds the accepted message.
    const second = await db('marketing_email_ledger').insert({
      customer_id: customerId, stream: 'alert', marketing_class: 'marketing', email_key: 'mkt.alert.storm', idempotency_key: 'retry-key-2',
      recipient_email: customerEmail, status: 'failed', reason: 'provider_rejected', reserved_at: new Date(Date.now() - 60 * 60 * 1000),
    }).returning(['id']);
    const [message] = await db('email_messages').insert({
      idempotency_key: 'retry-key-2', recipient_email_snapshot: customerEmail, recipient_type: 'customer', recipient_id: customerId,
      template_key: 'mkt.alert.storm', status: 'sent', sent_at: new Date(), provider_message_id: 'sg-synthetic-3',
    }).returning(['id']);
    try {
      const next = await attempt('after-retries');
      const promoted = await db('marketing_email_ledger').where({ id: second[0].id }).first();
      expect(promoted.status).toBe('sent');
      expect(promoted.email_message_id).toBe(message.id);
      // Two marketing sends now stand: the next attempt is denied by the caps.
      expect(next.ok).toBe(false);
    } finally {
      await db('email_messages').where({ id: message.id }).del();
    }
  });

  test('GitHub round P1: a same-key retry of a FAILED reservation whose message never went out is reopened as reserved', async () => {
    const first = await attempt('reopen-key');
    await Ledger.markFailed(first.row.id, 'timeout');
    const again = await attempt('reopen-key');
    expect(again.ok).toBe(true);
    expect(again.reopened).toBe(true);
    expect(again.row.status).toBe('reserved');
    expect(again.row.id).toBe(first.row.id);
  });

  test('GitHub round P1: a failure reported against a message the provider accepted completes the row as sent instead', async () => {
    const first = await attempt('lost-response-key');
    const [message] = await db('email_messages').insert({
      idempotency_key: 'lost-response-key', recipient_email_snapshot: customerEmail, recipient_type: 'customer', recipient_id: customerId,
      template_key: 'mkt.broadcast.weekly', status: 'sent', sent_at: new Date(), provider_message_id: 'sg-synthetic-2',
    }).returning(['id']);
    try {
      const changed = await Ledger.markFailed(first.row.id, 'timeout_waiting_for_provider');
      expect(changed).toBe(true);
      const row = await db('marketing_email_ledger').where({ id: first.row.id }).first();
      expect(row.status).toBe('sent');
      expect(row.email_message_id).toBe(message.id);
    } finally {
      await db('email_messages').where({ id: message.id }).del();
    }
  });

  test('GitHub round P2: an idempotency key already used for another customer is refused, never returned as that customer\'s duplicate', async () => {
    const otherId = randomUUID();
    await db('customers').insert({
      id: otherId, first_name: 'Synthetic', last_name: 'Other', phone: `+1941556${String(Math.floor(Math.random() * 9000) + 1000)}`,
      email: `${otherId}@example.invalid`, active: true,
    });
    await db('notification_prefs').insert({ customer_id: otherId, email_enabled: true, marketing_offers: true });
    try {
      const mine = await attempt('campaign-2026-10');
      expect(mine.ok).toBe(true);
      const theirs = await Ledger.reserveWithCap({
        customerId: otherId, stream: 'broadcast', marketingClass: 'marketing',
        emailKey: 'mkt.broadcast.weekly', idempotencyKey: 'campaign-2026-10', now: new Date(),
      });
      expect(theirs).toEqual({ ok: false, reason: Eligibility.REASONS.IDEMPOTENCY_KEY_CONFLICT, row: null, duplicate: false });
      const rows = await db('marketing_email_ledger').where({ idempotency_key: 'campaign-2026-10' });
      expect(rows).toHaveLength(1);
      expect(rows[0].customer_id).toBe(customerId);
    } finally {
      await db('marketing_email_ledger').where({ customer_id: otherId }).del();
      await db('notification_prefs').where({ customer_id: otherId }).del();
      await db('customers').where({ id: otherId }).del();
    }
  });

  test('finding 1 (codex round 1): a stale reservation no longer blocks and is settled as abandoned', async () => {
    const [staleRow] = await db('marketing_email_ledger').insert({
      customer_id: customerId, stream: 'broadcast', marketing_class: 'marketing',
      email_key: 'mkt.broadcast.weekly', idempotency_key: `stale-${randomUUID()}`,
      recipient_email: customerEmail, status: 'reserved',
      reserved_at: new Date(Date.now() - 31 * 60 * 1000), // 31 minutes ago — past the 30-minute lifetime
    }).returning('*');

    const result = await attempt('fresh-after-stale');
    expect(result.ok).toBe(true);
    expect(result.row.id).not.toBe(staleRow.id);

    const settled = await db('marketing_email_ledger').where({ id: staleRow.id }).first();
    expect(settled.status).toBe('failed');
    expect(settled.reason).toBe('abandoned_reservation');
  });

  test('finding 2 (codex round 1): retrying an already-sent idempotency key returns duplicate:true, not a cap denial', async () => {
    const first = await attempt('sent-then-retried');
    expect(first.ok).toBe(true);
    await Ledger.markSent(first.row.id, { emailMessageId: null });

    const retry = await attempt('sent-then-retried');
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(retry.row.id).toBe(first.row.id);
    expect(retry.row.status).toBe('sent');

    const rows = await db('marketing_email_ledger').where({ customer_id: customerId });
    expect(rows).toHaveLength(1); // the retry never inserted a second row
  });

  test('finding 3 (codex round 1): markFailed after markSent leaves the row sent, never demoted', async () => {
    const first = await attempt('sent-then-late-fail');
    expect(first.ok).toBe(true);
    await Ledger.markSent(first.row.id, { emailMessageId: null });

    const changed = await Ledger.markFailed(first.row.id, 'late_failure');
    expect(changed).toBe(false);

    const row = await db('marketing_email_ledger').where({ id: first.row.id }).first();
    expect(row.status).toBe('sent');
    expect(row.reason).toBeNull(); // the rejected markFailed never wrote its reason either
  });

  test('CI push audit (codex): retrying markSent on an already-sent row preserves the original sent_at and email_message_id', async () => {
    const first = await attempt('sent-then-retried-completion');
    expect(first.ok).toBe(true);
    const originalMessageId = randomUUID();
    await Ledger.markSent(first.row.id, { emailMessageId: originalMessageId });
    const original = await db('marketing_email_ledger').where({ id: first.row.id }).first();
    expect(original.email_message_id).toBe(originalMessageId);

    // A retry (e.g. the caller lost the first response) omits the id and
    // must not move sent_at forward or erase the original linkage.
    const changed = await Ledger.markSent(first.row.id, {});
    expect(changed).toBe(0);

    const after = await db('marketing_email_ledger').where({ id: first.row.id }).first();
    expect(after.email_message_id).toBe(originalMessageId);
    expect(after.sent_at.getTime()).toBe(original.sent_at.getTime());
  });
});
