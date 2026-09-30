/**
 * marketing_email_ledger writer — the one place every future email/division
 * sender records "this customer was (about to be) sent this email". NOT
 * WIRED to any sender yet.
 *
 * RECORD-THEN-SEND, same doctrine as collections/contact-ledger.js: a row is
 * reserved BEFORE the provider call, so a crash between reserve and send only
 * leaves a `reserved` row (safe — it never counts toward the eligibility
 * caps, which read `sent` rows only), never a contact with no record of it.
 *
 * sendWithLedger is the documented entry point: reserve → sendTemplate under
 * the reservation's own idempotency key and template key, with the fence
 * composed INTO the library's locked provider handoff (reservationHandoff:
 * the reservation is proven ours and consent is judged again immediately
 * before the provider request) → settle from the outcome. The primitives
 * (reserveWithCap, reservationHandoff, markSent, markSkipped, markFailed)
 * stay exported for a sender that must hold other authority rows around the
 * provider call, under the contract each one documents — passing
 * reservationHandoff as sendTemplate's withProviderHandoff is not optional on
 * that path (codex GitHub round P1s).
 */

const db = require('../../models/db');
const { sendTemplate } = require('../email-template-library');
const {
  eligibleForEmail, resolveMarketingClass, groupKeyFor, REASONS,
} = require('./eligibility');

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
// What the delivery authority says about a key. email_messages carries
// more than sent_at: the library stamps provider_handoff_phase 'started' the
// moment the request is handed to SendGrid and 'rejected' when SendGrid
// refuses it; a worker that dies between acceptance and recordAcceptance
// leaves 'started' with no sent_at — an UNCERTAIN delivery the library itself
// refuses to retry (codex GitHub round P1). Kinds:
//   accepted  — sent_at set: the email went out.
//   uncertain — handoff 'started', no sent_at: it may have gone out.
//   rejected  — handoff 'rejected', or a terminal failed/blocked/aborted row.
//   pending   — a row that never reached the provider (queued/pending).
//   none      — no email_messages row for the key.
async function messageStateFor(trx, idempotencyKey) {
  if (!idempotencyKey) return { kind: 'none', message: null };
  const message = await trx('email_messages')
    .where({ idempotency_key: idempotencyKey })
    .first('id', 'sent_at', 'status', 'provider_handoff_phase', 'updated_at');
  if (!message) return { kind: 'none', message: null };
  if (message.sent_at) return { kind: 'accepted', message };
  const phase = String(message.provider_handoff_phase || '').toLowerCase();
  if (phase === 'started') return { kind: 'uncertain', message };
  if (phase === 'rejected' || ['failed', 'blocked', 'aborted'].includes(String(message.status || '').toLowerCase())) {
    return { kind: 'rejected', message };
  }
  return { kind: 'pending', message };
}

// An accepted OR uncertain handoff completes the reservation as `sent`: the
// caps then count an email that went out (or may have), never the other way
// round — a duplicate marketing email is the failure this ledger exists to
// prevent, a possibly-uncounted miss is not.
async function completeFromMessage(trx, id, state, fromStatuses = ['reserved']) {
  return trx('marketing_email_ledger').where({ id }).whereIn('status', fromStatuses).update({
    status: 'sent',
    sent_at: state.message.sent_at || state.message.updated_at || trx.fn.now(),
    email_message_id: state.message.id,
    reason: state.kind === 'accepted' ? 'reconciled_from_email_messages' : 'provider_handoff_uncertain',
    updated_at: trx.fn.now(),
  });
}

// A `failed` row whose message the library later retried under the shared
// key and got accepted must count too: markSent promotes such a row, and
// this sweep catches the case where nobody called markSent (codex GitHub
// round P1). Bounded to the window the caps read.
const FAILED_RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function settleAbandonedReservations(trx, customerId, now) {
  const staleCutoff = new Date(now.getTime() - RESERVATION_LIFETIME_MS);
  const stale = await trx('marketing_email_ledger')
    .where({ customer_id: customerId, status: 'reserved' })
    .where('reserved_at', '<=', staleCutoff)
    .select('id', 'idempotency_key');
  for (const row of stale) {
    const state = await messageStateFor(trx, row.idempotency_key);
    if (state.kind === 'accepted' || state.kind === 'uncertain') {
      await completeFromMessage(trx, row.id, state);
    } else {
      // The staleness is re-checked in the UPDATE itself: a lease renewal
      // (reservationHandoff) landing between the select above and here
      // means the owner is alive and about to dispatch, so the row is no
      // longer stale and stays reserved. Both run under the same customer
      // lock, so this is belt-and-braces, not the primary fence.
      await trx('marketing_email_ledger')
        .where({ id: row.id, status: 'reserved' })
        .where('reserved_at', '<=', staleCutoff)
        .update({
          status: 'failed',
          reason: state.kind === 'rejected' ? 'provider_rejected' : 'abandoned_reservation',
          updated_at: trx.fn.now(),
        });
    }
  }
  const failedRecently = await trx('marketing_email_ledger')
    .where({ customer_id: customerId, status: 'failed' })
    .where('reserved_at', '>', new Date(now.getTime() - FAILED_RECONCILE_WINDOW_MS))
    .select('id', 'idempotency_key');
  for (const row of failedRecently) {
    const state = await messageStateFor(trx, row.idempotency_key);
    if (state.kind === 'accepted' || state.kind === 'uncertain') await completeFromMessage(trx, row.id, state, ['failed']);
  }
  return stale.length;
}

// The row an idempotency key names must be THIS operation's: same customer,
// stream, email key, marketing class and pest. A key reused for another
// customer (a batch sender's campaign-level key, or two concurrent
// reservations resolving a conflict to each other's row) is refused, never
// returned as a duplicate that would silently skip a recipient (codex GitHub
// round P2). So is a same-key retry that changes the policy fields: the
// failed-row reopen below would otherwise judge eligibility on the new class
// or pest while the row kept the old ones, and a relationship row retried as
// marketing could be delivered outside every marketing cap (codex GitHub
// round P2).
function sameOperation(row, {
  customerId, stream, emailKey, marketingClass, pestKey = null,
}) {
  return row.customer_id === customerId && row.stream === stream && row.email_key === emailKey
    && row.marketing_class === marketingClass && (row.pest_key ?? null) === (pestKey ?? null);
}

async function reserve({
  customerId, stream, marketingClass: requestedClass, emailKey, idempotencyKey, recipientEmail, pestKey = null, conn,
} = {}) {
  const database = conn || db;
  const marketingClass = resolveMarketingClass(stream, emailKey, requestedClass);
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
  if (!sameOperation(existing, {
    customerId, stream, emailKey, marketingClass, pestKey,
  })) {
    const err = new Error(`idempotency key ${idempotencyKey} already belongs to another customer/stream/email/class/pest`);
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
    // `reserved` OR `failed`: a same-key provider retry that succeeded after
    // the caller had marked the row failed must still count (codex GitHub
    // round P1). Never `sent` (a retry of markSent stays a no-op) and never
    // `skipped` (the caller chose not to send).
    return trx('marketing_email_ledger').where({ id }).whereIn('status', ['reserved', 'failed']).update({
      status: 'sent',
      sent_at: trx.fn.now(),
      email_message_id: emailMessageId,
      reason: null,
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
    // A failure report against a message the provider accepted — or may
    // have (handoff started, response lost) — is not a failure: the row
    // completes as sent instead.
    const state = await messageStateFor(trx, existing.idempotency_key);
    if (state.kind === 'accepted' || state.kind === 'uncertain') return (await completeFromMessage(trx, id, state)) > 0;
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
 *     RESERVATION_LIFETIME_MS is settled from email_messages: to `sent`
 *     (linked to the message) when the provider accepted that key, or when
 *     the handoff started and the response was lost — both must keep
 *     counting toward the caps — else to `failed` (`provider_rejected`, or
 *     `abandoned_reservation` for a key that never reached the provider)
 *     (codex round-1 P1, GitHub rounds P1) — never counted as outstanding
 *     again.
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
  customerId, stream, marketingClass: requestedClass, emailKey, idempotencyKey, pestKey = null, now = new Date(),
} = {}) {
  // The class the caps, the human-contact check and the outstanding guard
  // key off is the RESOLVED one (eligibility.js resolveMarketingClass), and
  // it is what the row stores — a caller's 'relationship' on a broadcast
  // changes nothing (pre-push audit P1). An unknown class is the same
  // fail-closed denial eligibleForEmail gives it.
  let marketingClass;
  try {
    marketingClass = resolveMarketingClass(stream, emailKey, requestedClass);
  } catch {
    return { ok: false, reason: REASONS.LOOKUP_FAILED, row: null, duplicate: false };
  }
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${customerId}`]);
    await settleAbandonedReservations(trx, customerId, now);

    const existingByKey = await trx('marketing_email_ledger')
      .where({ idempotency_key: idempotencyKey })
      .first();
    if (existingByKey) {
      if (!sameOperation(existingByKey, {
        customerId, stream, emailKey, marketingClass, pestKey,
      })) {
        return { ok: false, reason: REASONS.IDEMPOTENCY_KEY_CONFLICT, row: null, duplicate: false };
      }
      if (existingByKey.status === 'failed') {
        // A same-key retry of a FAILED reservation. If the provider in fact
        // accepted the message since, the row completes as sent and reads
        // back as the duplicate it is; if the message is definitely unsent,
        // the row goes back to `reserved` — through the same eligibility and
        // cap checks a fresh reservation faces — so the caller's retry can
        // be completed by markSent (codex GitHub round P1).
        const state = await messageStateFor(trx, idempotencyKey);
        if (state.kind === 'accepted' || state.kind === 'uncertain') {
          await completeFromMessage(trx, existingByKey.id, state, ['failed']);
          const completed = await trx('marketing_email_ledger').where({ id: existingByKey.id }).first();
          return { ok: true, reason: null, row: completed, duplicate: true };
        }
        const retryVerdict = await eligibleForEmail({ customerId, stream, marketingClass, emailKey, pestKey, now, conn: trx });
        if (!retryVerdict.ok) return { ok: false, reason: retryVerdict.reason, row: null, duplicate: false };
        const otherOutstanding = marketingClass === 'marketing' ? await outstandingReservation(trx, customerId, idempotencyKey) : null;
        if (otherOutstanding) return { ok: false, reason: capReasonFor(stream, otherOutstanding.stream), row: null, duplicate: false };
        await trx('marketing_email_ledger').where({ id: existingByKey.id, status: 'failed' }).update({
          status: 'reserved', reserved_at: now, reason: null, recipient_email: retryVerdict.checks.customerEmail, updated_at: trx.fn.now(),
        });
        const reopened = await trx('marketing_email_ledger').where({ id: existingByKey.id }).first();
        return { ok: true, reason: null, row: reopened, duplicate: false, reopened: true };
      }
      return { ok: true, reason: null, row: existingByKey, duplicate: true };
    }

    const verdict = await eligibleForEmail({
      customerId, stream, marketingClass, emailKey, pestKey, now, conn: trx,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, row: null, duplicate: false };

    if (marketingClass === 'marketing') {
      const outstanding = await outstandingReservation(trx, customerId, idempotencyKey);
      if (outstanding) return { ok: false, reason: capReasonFor(stream, outstanding.stream), row: null, duplicate: false };
    }

    try {
      const { row, duplicate } = await reserve({
        customerId, stream, marketingClass, emailKey, idempotencyKey,
        recipientEmail: verdict.checks.customerEmail, pestKey, conn: trx,
      });
      return { ok: true, reason: null, row, duplicate };
    } catch (err) {
      // Two customers reserving the same global key at once: their
      // per-customer locks do not serialize them, the loser's insert hits
      // ON CONFLICT DO NOTHING and its read-back is another customer's row.
      // That is the same policy denial as the pre-insert check, never a
      // thrown server error (codex GitHub round P2).
      if (err.code === 'IDEMPOTENCY_KEY_CONFLICT') return { ok: false, reason: REASONS.IDEMPOTENCY_KEY_CONFLICT, row: null, duplicate: false };
      throw err;
    }
  });
}

function outstandingReservation(trx, customerId, idempotencyKey) {
  return trx('marketing_email_ledger')
    .where({ customer_id: customerId, marketing_class: 'marketing', status: 'reserved' })
    .whereNot({ idempotency_key: idempotencyKey })
    .first('stream');
}

function capReasonFor(stream, outstandingStream) {
  return (stream === 'broadcast' || stream === 'alert') && outstandingStream === stream
    ? (stream === 'broadcast' ? REASONS.CAP_WEEKLY_BROADCAST : REASONS.CAP_WEEKLY_ALERT)
    : REASONS.CAP_SAME_DAY;
}

// --- the provider-boundary fence --------------------------------------------
//
// Composed THROUGH sendTemplate's locked handoff, never checked before
// entering the library (codex GitHub round P1s): template loading, rendering
// and the library's own suppression work sit between a pre-flight check and
// the provider request, and a preference change or the stale-reservation
// sweep in that interval must still stop the send. Two steps:
//
//   holdReservation — inside the handoff, under the same per-customer lock
//   the sweep runs under, held through the provider request. The delivery
//   authority is asked first: a key email_messages shows accepted, or handed
//   off with the response lost, is an email that went out (a crash between
//   acceptance and markSent inside the sweep's lifetime) — the row completes
//   as `sent`, answers ALREADY_DISPATCHED, and nothing more is dispatched.
//   Then the row must still be `reserved` and its lease is renewed: a worker
//   paused past RESERVATION_LIFETIME_MS finds the sweep has settled its row
//   and another key may since have been sent — RESERVATION_RECLAIMED, no
//   dispatch. Serializing on the lock is what closes the select/renew/settle
//   interleaving: whichever transaction holds it first runs to completion.
//
//   judgeConsent — sendOne's providerBoundaryCheck, which the library runs
//   after all of its asynchronous preparation and immediately before the
//   provider request: eligibility is judged AGAIN from the row's own
//   stream/key/class/pest (never caller arguments), on the same transaction,
//   and the address the library is about to send to must be the one this
//   recheck cleared. A customer who switched email off, turned marketing
//   offers off, moved the category to SMS, was suppressed or put on the
//   staff do-not-contact list since the reservation is skipped here, with
//   the verdict's reason, and the request is vetoed through the library's
//   own `providerBoundaryBlocked` protocol (a definite non-send) — the
//   reservation was a snapshot, never continuing authorization.

async function holdReservation(trx, id, now) {
  const row = await trx('marketing_email_ledger').where({ id }).first();
  if (!row) return { ok: false, reason: REASONS.RESERVATION_RECLAIMED, row: null };
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`marketing-email:${row.customer_id}`]);
  const state = await messageStateFor(trx, row.idempotency_key);
  if (state.kind === 'accepted' || state.kind === 'uncertain') {
    await completeFromMessage(trx, id, state, ['reserved', 'failed']);
    return { ok: false, reason: REASONS.ALREADY_DISPATCHED, row };
  }
  const renewed = await trx('marketing_email_ledger')
    .where({ id, status: 'reserved' })
    .update({ reserved_at: now, updated_at: trx.fn.now() });
  if (!renewed) return { ok: false, reason: REASONS.RESERVATION_RECLAIMED, row };
  return { ok: true, reason: null, row };
}

function skipReservation(trx, id, reason) {
  return trx('marketing_email_ledger')
    .where({ id, status: 'reserved' })
    .update({ status: 'skipped', reason, updated_at: trx.fn.now() });
}

async function judgeConsent(trx, row, now) {
  const verdict = await eligibleForEmail({
    customerId: row.customer_id, stream: row.stream, marketingClass: row.marketing_class,
    emailKey: row.email_key, pestKey: row.pest_key, now, conn: trx,
  });
  if (!verdict.ok) {
    await skipReservation(trx, row.id, verdict.reason);
    return { ok: false, reason: verdict.reason, row };
  }
  if (verdict.checks.customerEmail !== row.recipient_email) {
    await skipReservation(trx, row.id, REASONS.RECIPIENT_CHANGED);
    return { ok: false, reason: REASONS.RECIPIENT_CHANGED, row };
  }
  return { ok: true, reason: null, row };
}

/**
 * sendTemplate's `withProviderHandoff`, bound to a reservation — the ONE way
 * a reservation reaches the provider (sendWithLedger passes it for you; a
 * sender on the primitives must pass it itself). The library's own abort
 * result does not carry the fence's reason, so `onVerdict` receives every
 * verdict as it is made: the hold's, then the boundary check's.
 */
function reservationHandoff(rowId, { onVerdict = () => {} } = {}) {
  return (dispatch) => db.transaction(async (trx) => {
    const now = new Date();
    const held = await holdReservation(trx, rowId, now);
    onVerdict(held);
    if (!held.ok) return { ok: false, reason: held.reason };
    await dispatch(trx, async () => {
      const verdict = await judgeConsent(trx, held.row, now);
      onVerdict(verdict);
      if (!verdict.ok) {
        const veto = new Error(`marketing email reservation ${rowId} refused at the provider boundary: ${verdict.reason}`);
        veto.providerBoundaryBlocked = true;
        veto.reason = verdict.reason;
        throw veto;
      }
    });
    return { ok: true };
  });
}

/**
 * The one dispatch path for an email-division sender. `template` is handed
 * to sendTemplate as given, except that the template key IS the judged email
 * key (a caller cannot judge an operational key and dispatch marketing or
 * win-back content under it — codex GitHub round P1; a different
 * `templateKey` is refused before anything is reserved), and the recipient
 * (`to`, recipientType 'customer', recipientId), the `idempotencyKey`, the
 * `suppressionGroupKey` and the `withProviderHandoff` are ALWAYS the
 * reservation's own — the shared key is what lets this ledger be reconciled
 * from email_messages, the group is the one eligibility judged, and the
 * handoff is the fence above. Never throws for a delivery outcome; returns
 *   { ok, sent, reason, row, duplicate, message?, error? }
 *   - denied / fenced / skipped: ok false, reason = the REASONS value or
 *     the library's own block reason;
 *   - duplicate: ok true, sent false, duplicate true — an earlier attempt
 *     under this key already owns the send (sent, or still in flight; a
 *     crashed owner's row is settled by the sweep after 30 minutes and a
 *     retry then reopens it);
 *   - sent: ok true, sent true, message = the email_messages row.
 * A thrown library error is settled through markFailed, which asks
 * email_messages first: a handoff that started (the library's own
 * EMAIL_PROVIDER_RETRY_HELD hold) or was accepted completes the row as
 * SENT and keeps counting toward the caps; a throw before any handoff
 * settles it as failed and frees the customer's slot at once.
 */
async function sendWithLedger({
  customerId, stream, marketingClass, emailKey, idempotencyKey, pestKey = null, now = new Date(), template = {},
} = {}) {
  if (template.templateKey != null && template.templateKey !== emailKey) {
    return { ok: false, sent: false, reason: REASONS.TEMPLATE_KEY_MISMATCH, row: null, duplicate: false };
  }
  const reservation = await reserveWithCap({
    customerId, stream, marketingClass, emailKey, idempotencyKey, pestKey, now,
  });
  if (!reservation.ok) {
    return { ok: false, sent: false, reason: reservation.reason, row: null, duplicate: false };
  }
  if (reservation.duplicate) {
    return { ok: true, sent: false, reason: 'duplicate', row: reservation.row, duplicate: true };
  }
  const { row } = reservation;

  let fence = null;
  let outcome;
  try {
    outcome = await sendTemplate({
      ...template,
      templateKey: row.email_key,
      to: row.recipient_email,
      recipientType: 'customer',
      recipientId: row.customer_id,
      idempotencyKey: row.idempotency_key,
      suppressionGroupKey: groupKeyFor(row.stream, row.email_key, row.marketing_class),
      withProviderHandoff: reservationHandoff(row.id, { onVerdict: (verdict) => { fence = verdict; } }),
    });
  } catch (err) {
    await markFailed(row.id, `dispatch_error:${err.code || err.status || 'unknown'}`);
    return { ok: false, sent: false, reason: 'dispatch_failed', row, duplicate: false, error: err };
  }
  // A fence refusal has already settled the row (completed from the
  // delivery authority, or skipped with the verdict's reason); the library's
  // abort result only says "aborted".
  if (fence && !fence.ok) {
    return { ok: false, sent: false, reason: fence.reason, row, duplicate: false };
  }
  return settleDispatchOutcome(row, outcome);
}

// A library result that is not `sent` is either a block (the library's own
// suppression/consent/recipient guards said no — a policy skip) or an abort
// (queued, never handed off — a failure); both settle through the
// reconciling primitives, so a result the delivery authority contradicts is
// corrected from email_messages rather than trusted.
async function settleDispatchOutcome(row, outcome) {
  if (outcome?.sent) {
    await markSent(row.id, { emailMessageId: outcome.message?.id || null });
    return { ok: true, sent: true, reason: null, row, duplicate: false, message: outcome.message || null };
  }
  const reason = String(outcome?.reason || (outcome?.blocked ? 'blocked' : 'aborted'));
  if (outcome?.blocked) await markSkipped(row.id, reason);
  else await markFailed(row.id, reason);
  return { ok: false, sent: false, reason, row, duplicate: false };
}

module.exports = {
  reserve, markSent, markSkipped, markFailed, reserveWithCap, reservationHandoff, sendWithLedger,
};
