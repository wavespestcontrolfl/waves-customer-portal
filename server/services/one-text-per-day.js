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
 *  - NO lock and NO connection held across the provider call. Standing down needs a delivered
 *    row, and only a completed send writes one, so two taps can never both stand down. Two taps at
 *    the same instant can both find no row and both send: a duplicate, the fail-open direction,
 *    and exactly what happens with the gate off. A technician taps visit 1, later visit 2, on one
 *    phone, so a truly simultaneous pair is rare; holding a database connection (and a lock) across
 *    a network call to prevent it is the worse trade (it can exhaust the pool, since the real
 *    senders take more connections themselves).
 *  - Proof of delivery is durable and written after the send: the proof row (a critical write) is
 *    written only once the sender returned success, retried once if the write fails, and logged
 *    loudly if it still fails. Then this visit never sends twice and the next same-day visit sends
 *    (a possible duplicate, never silence).
 *  - The proof describes the attempt that sent. The caller's COMPLETE attempt fence (the tuple its
 *    own claim used) is checked right before the send; an attempt whose visit was moved, re-armed
 *    or changed meanwhile sends as it would without the rule and records no proof, so a stale
 *    send cannot cover another visit.
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
async function deliveredSibling(conn, ref, kind, technicianId) {
  const rows = await conn('audit_log as al')
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
      conn.raw("al.metadata->>'customer_id' as customer_id"),
      conn.raw("al.metadata->>'property_id' as property_id"),
      conn.raw("al.metadata->>'day' as day"),
      conn.raw("al.metadata->>'technician_id' as delivered_technician_id"));
  return rows.find((r) => sameTextDay(ref, r) && String(r.delivered_technician_id || '') === String(technicianId || '')) || null;
}

async function recordTrackOutcome(ref, kind, covering, technicianId, { critical = false } = {}) {
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
  });
}

// The delivered proof: a critical write, retried once. Never throws: the text is already out.
async function recordDeliveryProof(ref, kind, technicianId) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await recordTrackOutcome(ref, kind, null, technicianId, { critical: true });
      return true;
    } catch (err) {
      last = err;
    }
  }
  logger.error(`[one-text-per-day] DELIVERY PROOF NOT RECORDED for ${kind} text of ${ref.id} (${last.code || last.name || 'error'}): the next same-day sibling will send`);
  return false;
}

// Covered by another visit's delivered text: stamp the guard and leave an audit trace. A failure of
// either only logs; the covering proof is what made the decision.
async function standDown(ref, covering, kind, named, fence) {
  try {
    await stampTrackGuard(kind, fence);
    await recordTrackOutcome(ref, kind, covering, named);
  } catch (err) {
    logger.error(`[one-text-per-day] ${kind} covered stamp failed for ${ref.id}: ${err.message}`);
  }
  logger.info(`[one-text-per-day] ${kind} text for ${ref.id} covered by ${covering.id} (delivered text, same customer, address, technician, day)`);
  return COVERED_BY_DAY;
}

/**
 * Run a tracker text's sender `sendFn` (returns the sender's result) once per customer, address,
 * technician and day (`technicianId`: the person the text names; the scheduled technician when not
 * given). Flow, with no transaction and no lock around the send:
 *  1. Gate off, no saved address, or a read error: the sender runs as without the rule.
 *  2. Read the visit through the caller's attempt `fence`; gone or changed: send, record no proof.
 *  3. Look for another visit's delivered row (same customer, address, ET day, kind, technician).
 *  4. Found: stamp the guard, write the covered audit row, return COVERED_BY_DAY.
 *  5. Else run the sender ONCE (a throw propagates; it is never run twice).
 *  6. Only on success, write the delivered proof (critical, retried once).
 */
async function sendTrackTextOnce(svc, kind, sendFn, { fence = null, technicianId = null } = {}) {
  let applies = false;
  try {
    applies = Boolean(TRACK_TEXTS[kind] && svc && svc.property_id && oneTextPerCustomerDayLive());
  } catch {
    applies = false;
  }
  if (!applies) return sendFn();
  let ref = null;
  let named = null;
  try {
    ref = await loadRef(db, svc, fence);
    named = ref ? (technicianId || ref.technician_id) : null;
    const covering = ref ? await deliveredSibling(db, ref, kind, named) : null;
    if (covering) return await standDown(ref, covering, kind, named, fence);
  } catch (err) {
    logger.error(`[one-text-per-day] ${kind} once-per-day check failed for ${svc.id} (sent as usual): ${err.message}`);
    ref = null;
  }
  const result = await sendFn();
  if (ref && result && result.success === true) await recordDeliveryProof(ref, kind, named);
  return result;
}

module.exports = {
  sameTextDay,
  dayOf,
  sendTrackTextOnce,
};
