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

// email_messages is the durable delivery authority: sendTemplate records
// provider acceptance there (status 'sent', sent_at) before it returns.
// CONTRACT for every caller of this ledger: pass the reservation's
// idempotency_key as sendTemplate's `idempotencyKey`, so the two ledgers
// share the key. That is what lets this ledger be reconciled from the
// truth instead of guessing: a crash between provider acceptance and
// markSent leaves a `reserved` row here whose email DID go out, and it must
// be counted toward the caps, never written off as abandoned (codex GitHub
// round P1). A key with no accepted message is a reservation that never
// reached the provider.
async function acceptedMessageFor(trx, idempotencyKey) {
  if (!idempotencyKey) return null;
  return trx('email_messages')
    .where({ idempotency_key: idempotencyKey })
    .whereNotNull('sent_at')
    .first('id', 'sent_at');
}

async function completeFromAcceptedMessage(trx, id, accepted) {
  return trx('marketing_email_ledger').where({ id, status: 'reserved' }).update({
    status: 'sent',
    sent_at: accepted.sent_at,
    email_message_id: accepted.id,
    reason: 'reconciled_from_email_messages',
    updated_at: trx.fn.now(),
  });
}

async function settleAbandonedReservations(trx, customerId, now) {
  const staleCutoff = new Date(now.getTime() - RESERVATION_LIFETIME_MS);
  const stale = await trx('marketing_email_ledger')
    .where({ customer_id: customerId, status: 'reserved' })
    .where('reserved_at', '<=', staleCutoff)
    .select('id', 'idempotency_key');
  for (const row of stale) {
    const accepted = await acceptedMessageFor(trx, row.idempotency_key);
    if (accepted) {
      await completeFromAcceptedMessage(trx, row.id, accepted);
    } else {
      await trx('marketing_email_ledger')
        .where({ id: row.id, status: 'reserved' })
        .update({ status: 'failed', reason: 'abandoned_reservation', updated_at: trx.fn.now() });
    }
  }
  return stale.length;
}

// The row an idempotency key names must be THIS operation's: same customer,
// stream and email key. A key reused for another customer (a batch sender's
// campaign-level key, or two concurrent reservations resolving a conflict to
// each other's row) is refused, never returned as a duplicate that would
// silently skip a recipient (codex GitHub round P2).
function sameOperation(row, { customerId, stream, emailKey }) {
  return row.customer_id === customerId && row.stream === stream && row.email_key === emailKey;
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
  if (!sameOperation(existing, { customerId, stream, emailKey })) {
    const err = new Error(`idempotency key ${idempotencyKey} already belongs to another customer/stream/email`);
    err.code = 'IDEMPOTENCY_KEY_CONFLICT';
    throw err;
  }
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
//
// Only a still-`reserved` row is completed (codex round-1 P1, GitHub push
// audit): an unconditional update let a RETRY of markSent (e.g. a caller
// that lost the response and completes again) push `sent_at` forward and,
// if that retry omitted emailMessageId, erase the original linkage — moving
// this send within the weekly/daily cap windows and losing its provider
// reference despite no new send happening. A retry on an already-`sent`
// row is now a no-op that returns 0, leaving the original sent_at and
// email_message_id exactly as first recorded.
async function markSent(id, { emailMessageId = null } = {}, { conn } = {}) {
  const runner = conn || db;
  return runner.transaction(async (trx) => {
    const existing = await trx('marketing_email_ledger').where({ id }).first('customer_id');
    if (!existing) return 0;
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${existing.customer_id}`]);
    return trx('marketing_email_ledger').where({ id, status: 'reserved' }).update({
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
    const existing = await trx('marketing_email_ledger').where({ id }).first('customer_id', 'idempotency_key');
    if (!existing) return false;
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${existing.customer_id}`]);
    // A failure report against a message the provider already accepted is
    // a lost response, not a failure: the row completes as sent instead.
    const accepted = await acceptedMessageFor(trx, existing.idempotency_key);
    if (accepted) return (await completeFromAcceptedMessage(trx, id, accepted)) > 0;
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
 *     RESERVATION_LIFETIME_MS is settled: to `sent` (linked to the message)
 *     when email_messages shows the provider accepted that key — the
 *     crash-after-acceptance case, which must keep counting toward the caps —
 *     else to `failed`/`abandoned_reservation` (codex round-1 P1, GitHub
 *     round P1) — never counted as outstanding again.
 *   - an idempotency key already held by ANOTHER customer/stream/email key
 *     is refused with IDEMPOTENCY_KEY_CONFLICT (codex GitHub round P2).
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
    if (existingByKey) {
      if (!sameOperation(existingByKey, { customerId, stream, emailKey })) {
        return { ok: false, reason: REASONS.IDEMPOTENCY_KEY_CONFLICT, row: null, duplicate: false };
      }
      return { ok: true, reason: null, row: existingByKey, duplicate: true };
    }

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
