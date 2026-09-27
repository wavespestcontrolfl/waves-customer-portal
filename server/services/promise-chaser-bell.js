/**
 * Promise-chaser bell — rings staff when a LEAD calls back on a number that
 * still carries an open, unkept Waves promise (a callback, a quote, a time
 * to come out) from an earlier UNBOOKED call.
 *
 * Event-driven, unlike the one-hour SLA pager (followup-sla-watcher.js),
 * which fires on a timer once a promise's own deadline passes — this one
 * fires the moment the number calls again, whether or not that deadline has
 * passed yet. The two never double up on the same event: this bell's
 * dedupe key is its own 'promise_chaser' family (never the pager's rolling
 * 'call_commitment_overdue' post), and its message says the caller is on
 * the line NOW rather than that a deadline was missed.
 *
 * The existing repeat-caller bell (GATE_REPEAT_CALLER_BELL) only rings on
 * 3+ calls from one number inside 3 hours — it misses a single callback
 * hours later, which is this alert's whole scope.
 *
 * "Kept" reuses the SLA pager's own evidence check (followedUpIds): a visit
 * booked since, a call that reached the caller, or a staff-typed text.
 * Nothing here is reimplemented — a promise the pager would already count
 * as followed up never rings this bell either.
 *
 * Gated by GATE_PROMISE_CHASER_BELL (needs GATE_CALL_COMMITMENTS too — no
 * commitment rows exist without it). Bell only — no customer comms, no
 * writes to call_commitments or call_log.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { etDateString, formatETDate, formatETTime } = require('../utils/datetime-et');
const commitments = require('./call-commitments');
const { whereNotBlockedCall } = require('../middleware/spam-block');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { SLA_KINDS, followedUpIds, WHAT } = require('./followup-sla-watcher');

// What we promised, and when — the two facts the alert body must carry.
function describePromise(row) {
  const what = WHAT[row.kind] || 'follow-up';
  const at = row.call_started_at ? new Date(row.call_started_at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `${formatETDate(at)} ${formatETTime(at)}` : 'an earlier call';
  return { what, when };
}

/**
 * Called from the /voice webhook while the call is still ringing (first
 * delivery only — Twilio's own idempotency claim keeps a redelivery from
 * firing this twice), so the alert's "calling in now" is still true when
 * staff read it — unlike the repeat-caller bell, which can afford to wait
 * for the post-call grace since its own copy never claims immediacy. Pure
 * lookup + one notification send — no claim/lease, since each call fires
 * this at most once and the dedupeKey below is what keeps a same-day
 * repeat call from re-ringing.
 */
async function ringPromiseChaserIfNeeded(callSid) {
  if (!callSid || !isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return false;
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid)
      .modify(whereNotBlockedCall)
      .modify((qb) => whereNotSandboxCall(qb))
      .first();
    if (!call || call.direction !== 'inbound') return false;
    const phone = call.from_phone;
    if (!commitments.phoneDigits(phone)) return false;

    const now = new Date();
    // Every open Waves promise (callback / quote / time to come out) made
    // on an EARLIER call from this same number — never this call's own row,
    // which the recording pipeline has not even extracted yet.
    const rows = (await commitments.listOpenCommitments(db, {
      party: 'waves', phone, limit: 200, includeHints: true, now,
    })).filter((r) => SLA_KINDS.includes(r.kind) && String(r.call_log_id) !== String(call.id));
    if (!rows.length) return false;

    // Refresh the fulfillment proof for the candidate calls first — nothing
    // stamps it until someone opens the queue (the SLA pager's own rule).
    const callIds = [...new Set(rows.map((r) => r.call_log_id))];
    for (const id of callIds) {
      await commitments.refreshFulfillment(db, id).catch((err) => {
        logger.warn(`[promise-chaser-bell] fulfillment refresh failed for call ${id}: ${err.message}`);
      });
    }
    const live = await commitments.stillOpenIds(db, rows.map((r) => r.id), { now });
    let open = rows.filter((r) => live.has(r.id));
    if (!open.length) return false;

    // followedUpIds needs each row's call-ended time (promisedAt's basis) —
    // the same merge the SLA pager itself does before calling it.
    const calls = callIds.length
      ? await db('call_log').whereIn('id', callIds).select('id', 'created_at', 'duration_seconds', 'bridged_at', 'direction')
      : [];
    const endedById = new Map(calls.map((c) => [c.id, commitments.callEndedAt(c)]));
    open = open.map((r) => ({ ...r, call_ended_at: endedById.get(r.call_log_id) || null }));

    // Booked since, called back and reached, or texted by staff since the
    // promise — the SLA pager's own "kept" evidence, reused rather than
    // reimplemented. A lookup failure fails closed: an unproven "kept" must
    // never ring.
    const followed = await followedUpIds(db, open).catch((err) => {
      logger.warn(`[promise-chaser-bell] follow-up lookup failed: ${err.message}`);
      return null;
    });
    if (followed === null) return false;
    open = open.filter((r) => !followed.has(r.id));
    if (!open.length) return false;

    // The promise the caller has waited longest for.
    open.sort((a, b) => new Date(a.call_started_at) - new Date(b.call_started_at));
    const promise = open[0];
    const { what, when } = describePromise(promise);

    const customer = call.customer_id
      ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
      : null;

    const { triggerNotification } = require('./notification-triggers');
    // Once per promise per ET day — a caller who rings twice in an
    // afternoon does not double the bell (notifyAdmin's own dedupe lock).
    const dedupeKey = `waves-promise_chaser-${promise.id}-${etDateString(now)}`;
    const stats = await triggerNotification('promise_chaser', {
      customerId: call.customer_id || null,
      name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
      phone,
      callLogId: call.id,
      commitmentId: promise.id,
      what,
      when,
    }, { dedupeKey });
    return Boolean(stats && !stats.error
      && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
  } catch (err) {
    logger.warn(`[promise-chaser-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

module.exports = { ringPromiseChaserIfNeeded, describePromise };
