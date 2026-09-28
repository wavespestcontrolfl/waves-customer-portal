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

async function markSkipped(id, reason, { conn } = {}) {
  const database = conn || db;
  return database('marketing_email_ledger').where({ id }).update({
    status: 'skipped', reason, updated_at: database.fn.now(),
  });
}

async function markFailed(id, reason, { conn } = {}) {
  const database = conn || db;
  return database('marketing_email_ledger').where({ id }).update({
    status: 'failed', reason, updated_at: database.fn.now(),
  });
}

/**
 * Eligibility-checked reservation: takes a per-customer advisory lock for
 * the transaction's lifetime (serializing concurrent attempts for the same
 * customer), runs eligibleForEmail against that same transaction, and only
 * on an `ok` verdict inserts the reservation. Returns `{ ok, reason, row,
 * duplicate }` — `row` is null on a denial.
 *
 * Two hardenings beyond a bare eligibility check + insert (codex pre-push
 * r1, both P1):
 *   - eligibleForEmail's caps only read `sent` rows, so two concurrent
 *     attempts under DIFFERENT idempotency keys could both pass eligibility
 *     and both reserve before either is marked sent, blowing past the
 *     weekly/daily caps. While still holding this customer's advisory lock,
 *     a marketing-class attempt also denies on any OTHER still-`reserved`
 *     (not yet sent/skipped/failed) row for this customer, reusing the
 *     stream-appropriate cap reason.
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
