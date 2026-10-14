/**
 * One on-the-way text and one arrived text per customer, service address and day
 * (GATE_ONE_TEXT_PER_CUSTOMER_DAY).
 *
 * Owner 2026-10-12/13: a customer with two services at one saved address on one
 * ET day, worked by the same technician, gets ONE "on the way" text and ONE
 * "arrived" text. Appointment reminders are NOT changed by this rule: two
 * services at the same start time already get one reminder from the existing
 * same-slot merge (registerVisitReminderInTx and the reminder sync trigger).
 * The rule never reads or writes `visit_id`, `service_visits` or `visit_effects`.
 *
 * PRINCIPLES
 *  - Coverage is decided from the RECORDED delivery only. A `track.one_text_per_day.delivered`
 *    audit row records who was told what: the customer, the property (service address), the ET
 *    day, the kind, and the technician the text named. A later visit is covered when such a row
 *    exists for the same customer, property, ET day, kind and technician, written by another
 *    visit that still exists and is not in a retained-history status (cancelled, skipped,
 *    no-show, rescheduled). The sibling's CURRENT address, date, assignment or track state is
 *    never read; the per-row guard columns (`track_sms_sent_at`, `arrival_sms_sent_at`) are
 *    stamped before a send, even when the text is disabled, and prove nothing.
 *  - Proof of delivery is durable and written WITH the send. `sendTrackTextOnce` holds an
 *    advisory lock on customer + address + day + kind from the check until the proof is
 *    committed, writes the proof row (a critical write) only after the sender returned
 *    success, and if that write fails writes it again while still holding the lock. If the
 *    proof still cannot be written, this visit never sends twice and the next same-day visit
 *    sends (a possible duplicate, never silence).
 *  - The proof describes the attempt that sent. The caller's schedule fence is re-checked under
 *    the lock before the send; an attempt whose visit was moved or changed meanwhile sends as it
 *    would without the rule and records no proof, so a stale send cannot cover another visit.
 *  - "Could not read" is never "already told": every read or write error fails OPEN toward the
 *    customer being informed (the text goes out as with the gate off).
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const auditLog = require('./audit-log');
const { oneTextPerCustomerDayLive } = require('../config/feature-gates');
const { RETAINED_HISTORY_STATUSES } = require('./visit-context/statuses');

const TRACK_TEXTS = {
  en_route: { stamp: 'track_sms_sent_at' },
  arrived: { stamp: 'arrival_sms_sent_at' },
};
const DELIVERED_ACTION = 'track.one_text_per_day.delivered';
const COVERED_BY_DAY = Object.freeze({ success: false, suppressed: true, reason: 'covered_by_day' });

// ET calendar day of a row: an explicit `day` (YYYY-MM-DD) wins, else the ET day
// of its appointment instant. Never reads a pg DATE as a Date (UTC midnight).
function dayOf(row) {
  if (row && row.day) return String(row.day).slice(0, 10);
  if (row && row.appointment_time) return etDateString(new Date(row.appointment_time));
  return null;
}

// Pure rule: the same customer, the same saved service address (both known) and
// the same ET day. `sameTechnician` adds the technician for the tracker texts,
// which name the person at the door.
function sameTextDay(a, b, { sameTechnician = false } = {}) {
  if (!a || !b || !a.customer_id || !a.property_id) return false;
  if (String(a.customer_id) !== String(b.customer_id)) return false;
  if (String(a.property_id) !== String(b.property_id)) return false;
  const day = dayOf(a);
  if (!day || day !== dayOf(b)) return false;
  return !sameTechnician || String(a.technician_id || '') === String(b.technician_id || '');
}

// The visit as it is NOW, only while it still matches the attempt that is about to send: the caller's
// schedule fence (the tuple its own claim used) and the customer and address of its snapshot.
// Null = gone, or moved/changed since the attempt read it (a stale attempt).
async function loadRef(conn, svc, fence) {
  const query = conn('scheduled_services').where({ id: svc.id });
  if (fence) query.where(fence);
  const ref = await query.first('id', 'customer_id', 'property_id', 'technician_id', conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
  const same = ref && String(ref.customer_id) === String(svc.customer_id) && String(ref.property_id) === String(svc.property_id);
  return same ? ref : null;
}

// ---- Tracker texts (en route, arrived) -------------------------------------

async function stampTrackGuard(kind, fence) {
  // Arrival already holds its guard (the CAS claim). En route stamps the covered
  // row the way the visit fan-out's "covered" stamp does, fenced to the attempt.
  if (kind !== 'en_route' || !fence) return;
  await db('scheduled_services').where(fence).whereNull(TRACK_TEXTS[kind].stamp).update({ [TRACK_TEXTS[kind].stamp]: new Date() });
}

// Another visit's "delivered" row for this kind that told the SAME customer, at the SAME
// address, on the SAME ET day, naming the SAME person: proof the customer was really told. All of
// it is read from the recorded delivery (the person is the one the text named, which for an
// arrival can be the one who actually arrived, not the scheduled one). The sibling is consulted
// only to see that it still exists and is not in a retained-history status.
async function deliveredSibling(trx, ref, kind, technicianId) {
  const rows = await trx('audit_log as al')
    .join('scheduled_services as sib', 'sib.id', 'al.resource_id')
    .where('al.action', DELIVERED_ACTION)
    .whereRaw("al.metadata->>'kind' = ?", [kind])
    .whereRaw("al.metadata->>'day' = ?", [ref.day])
    .whereRaw("al.metadata->>'customer_id' = ?", [String(ref.customer_id)])
    .whereRaw("al.metadata->>'property_id' = ?", [String(ref.property_id)])
    .whereNot('sib.id', ref.id)
    // A visit that did not happen (cancelled, skipped, no-show, awaiting re-placement) told the customer
    // nothing about THIS service: the canonical non-performed list. A completed visit still covers.
    .whereNotIn('sib.status', RETAINED_HISTORY_STATUSES)
    .select('sib.id',
      trx.raw("al.metadata->>'customer_id' as customer_id"),
      trx.raw("al.metadata->>'property_id' as property_id"),
      trx.raw("al.metadata->>'day' as day"),
      trx.raw("al.metadata->>'technician_id' as delivered_technician_id"));
  return rows.find((r) => sameTextDay(ref, r) && String(r.delivered_technician_id || '') === String(technicianId || '')) || null;
}

async function recordTrackOutcome(trx, ref, kind, covering, technicianId, { critical = false } = {}) {
  await auditLog.recordAuditEvent({
    critical,
    actor_type: 'system',
    action: covering ? `track.one_text_per_day.${kind}` : DELIVERED_ACTION,
    resource_type: 'scheduled_service',
    resource_id: ref.id,
    metadata: {
      kind, customer_id: ref.customer_id, property_id: ref.property_id, day: ref.day,
      technician_id: technicianId || null,
      ...(covering ? { covered_by_scheduled_service_id: covering.id } : {}),
    },
    trx,
  });
}

async function lockTrackDay(trx, ref, kind) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
    [`one-text-day:${kind}:${ref.customer_id}:${ref.property_id}:${ref.day}`]);
}

/**
 * Run a tracker text's sender `sendFn` (returns the sender's result) once per
 * customer, address, technician and day (`technicianId`: the person the text names; the
 * scheduled technician when not given). With the gate on and a saved address,
 * the check and the send happen under one advisory lock, so a second tap waits
 * for the first send to finish and then sees its "delivered" row. A sender that
 * did not return success leaves no row, so the next tap sends. `fence` is the caller's
 * schedule tuple for this attempt: if the visit no longer matches it (moved, re-armed) the
 * send goes out as it would without the rule and records no proof. Returns the sender's
 * result, or COVERED_BY_DAY (a suppressed, handled result) after stamping the guard and
 * writing an audit row. Gate off, no saved address, or a failure before the send: the sender
 * runs as without the rule.
 */
async function sendTrackTextOnce(svc, kind, sendFn, { fence = null, technicianId = null } = {}) {
  let applies = false;
  try {
    applies = Boolean(TRACK_TEXTS[kind] && svc && svc.property_id && oneTextPerCustomerDayLive());
  } catch {
    applies = false;
  }
  if (!applies) return sendFn();
  const state = { sending: false, done: false, result: null, proof: null };
  try {
    // The OUTER transaction owns the advisory lock until it ends; the check, the send and the
    // proof run in a savepoint inside it, so a failed proof write rolls back only that part
    // and the lock is still held while the proof is written again (rescueDeliveryProof).
    return await db.transaction((outer) => lockedTrackText({ outer, svc, kind, sendFn, fence, technicianId, state }));
  } catch (err) {
    // The sender itself threw: its caller handles that, as without the rule.
    if (state.sending && !state.done) throw err;
    logger.error(`[one-text-per-day] ${kind} once-per-day bookkeeping failed for ${svc.id}: ${err.message}`);
    // Bookkeeping failed AFTER a real send: never send a second one for this visit, and keep the proof.
    if (state.sending) return rescueDeliveryProof(db, state, kind);
    return sendFn();
  }
}

async function lockedTrackText({ outer, svc, kind, sendFn, fence, technicianId, state }) {
  const send = async () => {
    state.sending = true;
    state.result = await sendFn();
    state.done = true;
    return state.result;
  };
  const first = await loadRef(outer, svc, fence);
  if (!first) return send();
  await lockTrackDay(outer, first, kind);
  // Re-checked under the lock, immediately before the send: still the attempt that was claimed.
  const ref = await loadRef(outer, svc, fence);
  if (!ref) return send();
  const named = technicianId || ref.technician_id;
  try {
    return await outer.transaction(async (inner) => {
      const covering = await deliveredSibling(inner, ref, kind, named);
      if (covering) {
        await stampTrackGuard(kind, fence);
        await recordTrackOutcome(inner, ref, kind, covering, named);
        logger.info(`[one-text-per-day] ${kind} text for ${ref.id} covered by ${covering.id} (delivered text, same customer, address, technician, day)`);
        return COVERED_BY_DAY;
      }
      const result = await send();
      state.proof = result && result.success === true ? { ref, named } : null;
      // CRITICAL write: a database error must surface here, not be swallowed (the row is the only proof).
      if (state.proof) await recordTrackOutcome(inner, ref, kind, null, named, { critical: true });
      return result;
    });
  } catch (err) {
    if (state.sending && !state.done) throw err;
    logger.error(`[one-text-per-day] ${kind} once-per-day check or proof failed for ${svc.id}: ${err.message}`);
    // The savepoint rolled back; the lock is still held here.
    return state.sending ? rescueDeliveryProof(outer, state, kind) : send();
  }
}

// The text is already out but its proof row did not commit: write it again on `conn` (the outer
// transaction, still holding the day lock, so a waiting sibling sees the row when the lock
// releases). If that also fails, say so loudly: this visit's text stands as delivered, and the
// NEXT same-day sibling will send (a possible duplicate, never a silence).
async function rescueDeliveryProof(conn, state, kind) {
  if (!state.proof) return state.result;
  try {
    await recordTrackOutcome(conn === db ? null : conn, state.proof.ref, kind, null, state.proof.named, { critical: true });
  } catch (err) {
    logger.error(`[one-text-per-day] DELIVERY PROOF NOT RECORDED for ${kind} text of ${state.proof.ref.id} (${err.code || err.name || 'error'}): the next same-day sibling will send`);
  }
  return state.result;
}

module.exports = {
  sameTextDay,
  dayOf,
  sendTrackTextOnce,
};
