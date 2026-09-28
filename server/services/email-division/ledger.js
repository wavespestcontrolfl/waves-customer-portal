/**
 * marketing_email_ledger writer — the one place every future email/division
 * sender records "this customer was (about to be) sent this email". NOT
 * WIRED to any sender yet.
 *
 * RECORD-THEN-SEND, same doctrine as collections/contact-ledger.js: a row is
 * reserved BEFORE the provider call, so a crash between reserve and send only
 * leaves a `reserved` row (safe — it never counts toward the eligibility
 * caps, which read `sent` rows only), never a contact with no record of it.
 */

const db = require('../../models/db');
const { eligibleForEmail, REASONS } = require('./eligibility');

// A 'reserved' row a worker never resolved (crashed, deployed over, timed
// out) must not block this customer's marketing email forever — codex
// round-1 P1. Settled to 'failed'/'abandoned_reservation' the next time
// ANY reservation attempt takes this customer's lock, so it stays visible
// in the ledger and is never counted again.
const RESERVATION_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

async function settleAbandonedReservations(trx, customerId, now) {
  const staleCutoff = new Date(now.getTime() - RESERVATION_LIFETIME_MS);
  await trx('marketing_email_ledger')
    .where({ customer_id: customerId, status: 'reserved' })
    .where('reserved_at', '<=', staleCutoff)
    .update({ status: 'failed', reason: 'abandoned_reservation', updated_at: trx.fn.now() });
}

async function reserve({
  customerId, stream, marketingClass, emailKey, idempotencyKey, recipientEmail, pestKey = null, conn,
} = {}) {
  const database = conn || db;
  const inserted = await database('marketing_email_ledger')
    .insert({
      customer_id: customerId,
      stream,
      marketing_class: marketingClass,
      email_key: emailKey,
      idempotency_key: idempotencyKey,
      recipient_email: recipientEmail,
      pest_key: pestKey,
      status: 'reserved',
    })
    .onConflict('idempotency_key')
    .ignore()
    .returning('*');
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  if (row) return { row, duplicate: false };
  const existing = await database('marketing_email_ledger')
    .where({ idempotency_key: idempotencyKey })
    .first();
  if (!existing) throw new Error('marketing email ledger reservation neither inserted nor found');
  return { row: existing, duplicate: true };
}

// Takes the SAME per-customer advisory lock as reserveWithCap before
// flipping to `sent` (codex pre-push r3 P1): without it, a concurrent
// reserveWithCap for a different idempotency key could split-read around
// this update under READ COMMITTED — its eligibility pass (reads `sent`
// rows) running before this commits, then its outstanding-reservation
// check (reads `reserved` rows) running after this commits and no longer
// seeing THIS row — passing both checks despite the send this cap exists
// to bound. Serializing the two transactions on the same lock makes that
// split-read impossible: whichever gets the lock first runs to completion
// before the other's checks can begin.
async function markSent(id, { emailMessageId = null } = {}, { conn } = {}) {
  const runner = conn || db;
  return runner.transaction(async (trx) => {
    const existing = await trx('marketing_email_ledger').where({ id }).first('customer_id');
    if (!existing) return 0;
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${existing.customer_id}`]);
    return trx('marketing_email_ledger').where({ id }).update({
      status: 'sent',
      sent_at: trx.fn.now(),
      email_message_id: emailMessageId,
      updated_at: trx.fn.now(),
    });
  });
}

// Only a still-`reserved` row may move to `skipped`/`failed` (codex round-1
// P1): an unconditional update could demote an already-`sent` row (two
// completion paths racing the same reservation — an acceptance path's
// markSent against a timed-out path's markFailed), and eligibility's caps
// would then stop counting a send that actually went out. Same per-customer
// lock as markSent, so this transition is serialized against a concurrent
// reserveWithCap the same way markSent is. Returns whether a row changed.
async function settleReservedOnly(id, status, reason, conn) {
  const runner = conn || db;
  return runner.transaction(async (trx) => {
    const existing = await trx('marketing_email_ledger').where({ id }).first('customer_id');
    if (!existing) return false;
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${existing.customer_id}`]);
    const changed = await trx('marketing_email_ledger')
      .where({ id, status: 'reserved' })
      .update({ status, reason, updated_at: trx.fn.now() });
    return changed > 0;
  });
}

async function markSkipped(id, reason, { conn } = {}) {
  return settleReservedOnly(id, 'skipped', reason, conn);
}

async function markFailed(id, reason, { conn } = {}) {
  return settleReservedOnly(id, 'failed', reason, conn);
}

/**
 * Eligibility-checked reservation: takes a per-customer advisory lock for
 * the transaction's lifetime (serializing concurrent attempts for the same
 * customer), runs eligibleForEmail against that same transaction, and only
 * on an `ok` verdict inserts the reservation. Returns `{ ok, reason, row,
 * duplicate }` — `row` is null on a denial.
 *
 * Under the SAME lock, before anything else:
 *   - any of this customer's `reserved` rows older than
 *     RESERVATION_LIFETIME_MS is settled to `failed`/`abandoned_reservation`
 *     (codex round-1 P1) — never counted as outstanding again.
 *   - a retry of an idempotency key that already exists returns
 *     `{ ok: true, duplicate: true, row }` for WHATEVER status that row
 *     holds, without ever re-running eligibility (codex round-1 P2): a
 *     retry of an already-`sent` key must read back as the duplicate it is,
 *     not an indistinguishable cap denial.
 *
 * Two more hardenings beyond a bare eligibility check + insert (codex
 * pre-push r1, both P1):
 *   - eligibleForEmail's caps only read `sent` rows, so two concurrent
 *     attempts under DIFFERENT idempotency keys could both pass eligibility
 *     and both reserve before either is marked sent, blowing past the
 *     weekly/daily caps. While still holding this customer's advisory lock,
 *     a marketing-class attempt also denies on any OTHER still-`reserved`
 *     (not yet sent/skipped/failed, and not yet abandoned) row for this
 *     customer, reusing the stream-appropriate cap reason.
 *   - the recipient actually stored is always the SAME email address
 *     eligibleForEmail just read and cleared against suppression (carried
 *     through in its `checks.customerEmail`, never a caller-supplied
 *     `recipientEmail` and never a second `customers` read of our own —
 *     a second read could observe a concurrent email change under READ
 *     COMMITTED and store an address that was never actually checked).
 */
async function reserveWithCap({
  customerId, stream, marketingClass, emailKey, idempotencyKey, pestKey = null, now = new Date(),
} = {}) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${customerId}`]);
    await settleAbandonedReservations(trx, customerId, now);

    const existingByKey = await trx('marketing_email_ledger')
      .where({ idempotency_key: idempotencyKey })
      .first();
    if (existingByKey) return { ok: true, reason: null, row: existingByKey, duplicate: true };

    const verdict = await eligibleForEmail({
      customerId, stream, marketingClass, emailKey, pestKey, now, conn: trx,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, row: null, duplicate: false };

    if (marketingClass === 'marketing') {
      const outstanding = await trx('marketing_email_ledger')
        .where({ customer_id: customerId, marketing_class: 'marketing', status: 'reserved' })
        .whereNot({ idempotency_key: idempotencyKey })
        .first('stream');
      if (outstanding) {
        const reason = (stream === 'broadcast' || stream === 'alert') && outstanding.stream === stream
          ? (stream === 'broadcast' ? REASONS.CAP_WEEKLY_BROADCAST : REASONS.CAP_WEEKLY_ALERT)
          : REASONS.CAP_SAME_DAY;
        return { ok: false, reason, row: null, duplicate: false };
      }
    }

    const { row, duplicate } = await reserve({
      customerId, stream, marketingClass, emailKey, idempotencyKey,
      recipientEmail: verdict.checks.customerEmail, pestKey, conn: trx,
    });
    return { ok: true, reason: null, row, duplicate };
  });
}

module.exports = { reserve, markSent, markSkipped, markFailed, reserveWithCap };
