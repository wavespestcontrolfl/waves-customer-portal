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
 *  - A text the provider reports undelivered is recorded by id (a `bounced` audit row written from the
 *    status callback, whether or not the proof exists yet); a proof any of whose ids has a bounced row
 *    no longer covers other visits (reconciled at read time). Nothing is re-sent retroactively.
 *  - The ONE arrived text names every service it covers (sender plus same-customer, property, day
 *    and technician visits with no text of their own), using the existing per-visit label builder.
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
const BOUNCED_ACTION = 'track.one_text_per_day.bounced';
const TRACK_PURPOSES = ['tech_en_route', 'tech_arrived'];
// A visit that can still be worked: its status, with a legacy NULL counted as live (as the scheduling paths do).
const LIVE_LABEL_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
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
  const ref = await query.first('id', 'customer_id', 'property_id', 'technician_id', 'service_type', conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
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
    .where(function liveOrLegacyNullStatus() {
      this.whereNull('sib.status').orWhereNotIn('sib.status', RETAINED_HISTORY_STATUSES);
    })
    // A delivered text any of whose provider ids was reported undelivered told nobody. Decided at READ time
    // from the recorded bounce, so it does not matter whether the bounce or the proof was written first.
    .whereRaw(`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(al.metadata->'provider_message_ids', '[]'::jsonb)) AS p(sid)
      JOIN audit_log b ON b.action = ? AND b.metadata->>'sid' = p.sid)`, [BOUNCED_ACTION])
    .select('sib.id',
      conn.raw("al.metadata->>'customer_id' as customer_id"),
      conn.raw("al.metadata->>'property_id' as property_id"),
      conn.raw("al.metadata->>'day' as day"),
      conn.raw("al.metadata->>'technician_id' as delivered_technician_id"));
  return rows.find((r) => sameTextDay(ref, r) && String(r.delivered_technician_id || '') === String(technicianId || '')) || null;
}

async function recordTrackOutcome(ref, kind, covering, technicianId, { critical = false, providerIds = [] } = {}) {
  await auditLog.recordAuditEvent({
    critical,
    actor_type: 'system',
    action: covering ? `track.one_text_per_day.${kind}` : DELIVERED_ACTION,
    resource_type: 'scheduled_service',
    resource_id: ref.id,
    metadata: {
      kind, customer_id: ref.customer_id, property_id: ref.property_id, day: ref.day,
      technician_id: technicianId || null,
      ...(providerIds.length ? { provider_message_ids: providerIds } : {}),
      ...(covering ? { covered_by_scheduled_service_id: covering.id } : {}),
    },
  });
}

// The delivered proof: a critical write, retried once. Never throws: the text is already out.
async function recordDeliveryProof(ref, kind, technicianId, providerIds) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await recordTrackOutcome(ref, kind, null, technicianId, { critical: true, providerIds });
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
 *  5. Else run the sender ONCE (a throw propagates; it is never run twice). An arrived text that stands
 *     for several visits gets their merged label (`sendFn({ serviceLabel })`; gate off: no argument).
 *  6. Only on success, and only if the visit still matches the fence after the provider call, write the
 *     delivered proof (critical, retried once) with the provider message ids, so an "undelivered"
 *     status callback can void it (`recordBouncedTrackText`).
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
  const label = ref ? await coveredServiceLabel(ref, kind, named) : null;
  const result = await (label ? sendFn({ serviceLabel: label }) : sendFn());
  if (ref && result && result.success === true) await proveIfCurrent(svc, fence, ref, kind, named, result);
  return result;
}

// The provider ids (Twilio SIDs) of the texts a sender result accepted, kept on the proof so a later
// "undelivered" status callback can void it.
function acceptedProviderIds(result) {
  const sent = Array.isArray(result && result.results) ? result.results.filter((r) => r && r.sent && r.providerMessageId) : [];
  return sent.map((r) => String(r.providerMessageId));
}

// The proof is written only if the visit STILL matches the attempt's complete fence after the provider
// call: a visit force-rescheduled or re-armed meanwhile sent a text about an abandoned snapshot, which
// must not stand down another visit (the text went out and records no proof: the fail-open direction).
async function proveIfCurrent(svc, fence, ref, kind, named, result) {
  let current = null;
  try {
    current = await loadRef(db, svc, fence);
  } catch (err) {
    logger.error(`[one-text-per-day] ${kind} post-send fence read failed for ${svc.id} (no proof recorded): ${err.message}`);
  }
  if (current) await recordDeliveryProof(ref, kind, named, acceptedProviderIds(result));
}

// Join distinct service labels list-style ("A, B & C"), the shape the reminder labels use.
function joinLabels(labels) {
  const parts = [];
  for (const raw of labels) {
    const label = String(raw || '').trim();
    if (label && label.toLowerCase() !== 'service' && !parts.some((p) => p.toLowerCase() === label.toLowerCase())) parts.push(label);
  }
  if (parts.length < 2) return parts[0] || null;
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

// The services ONE arrived text covers: the sender plus every live visit of the same customer, recorded
// property, ET day and technician that has no text of its own (delivered or covered) for this kind and
// day. Labelled with the existing per-visit label builder (parent + add-ons), so the single text names
// each of them. Null (the sender's own label, as today) for the on-the-way text, which names no
// service, for a lone visit, and on any lookup failure.
async function coveredServiceLabel(ref, kind, technicianId) {
  if (kind !== 'arrived') return null;
  try {
    const others = await db('scheduled_services as sib')
      .where({ 'sib.customer_id': ref.customer_id, 'sib.property_id': ref.property_id })
      .whereRaw("to_char(sib.scheduled_date, 'YYYY-MM-DD') = ?", [ref.day])
      .whereNot('sib.id', ref.id)
      .where(function sameTechnician() {
        if (technicianId) this.where('sib.technician_id', technicianId);
        else this.whereNull('sib.technician_id');
      })
      .where(function liveOrLegacyNullStatus() {
        this.whereNull('sib.status').orWhereIn('sib.status', LIVE_LABEL_STATUSES);
      })
      .whereNotExists(function alreadyTold() {
        this.select(1).from('audit_log as al')
          .whereRaw('al.resource_id = sib.id')
          .whereIn('al.action', [DELIVERED_ACTION, `track.one_text_per_day.${kind}`])
          .whereRaw("al.metadata->>'kind' = ?", [kind])
          .whereRaw("al.metadata->>'day' = ?", [ref.day]);
      })
      .orderBy('sib.window_start', 'asc')
      .orderBy('sib.id', 'asc')
      .select('sib.id', 'sib.service_type');
    if (!others.length) return null;
    const { buildServiceLabel } = require('./appointment-reminders');
    const labels = [];
    for (const v of [ref, ...others]) labels.push(await buildServiceLabel(v.id, v.service_type));
    return joinLabels(labels);
  } catch (err) {
    logger.warn(`[one-text-per-day] covered-service label lookup failed for ${ref.id} (own label used): ${err.message}`);
    return null;
  }
}

// Is the message with this provider id a tracker text? Read from the log rows the send wrote (the audit
// row's purpose, else the sms_log message type). Not logged yet (the callback raced the log insert): yes,
// because a bounced row only ever matters to a proof that lists this id.
async function isTrackerText(sid) {
  const audit = await db('messaging_audit_log').where({ provider_message_id: sid }).first('purpose');
  if (audit) return TRACK_PURPOSES.includes(audit.purpose);
  const log = await db('sms_log').where({ twilio_sid: sid }).first('message_type');
  return log ? TRACK_PURPOSES.includes(log.message_type) : true;
}

/**
 * A provider "failed / undelivered" status callback for `sid`: if it is an on-the-way or arrived text,
 * record the bounce by id (one `bounced` row per id; a repeated callback writes nothing more). Coverage
 * is reconciled at read time (deliveredSibling), whether the proof exists yet or not. A no-op with the
 * gate off; never throws (it is called from the webhook).
 */
async function recordBouncedTrackText({ sid } = {}) {
  try {
    if (!sid || !oneTextPerCustomerDayLive() || !(await isTrackerText(sid))) return 0;
    const seen = await db('audit_log').where({ action: BOUNCED_ACTION }).whereRaw("metadata->>'sid' = ?", [String(sid)]).first('id');
    if (seen) return 0;
    await auditLog.recordAuditEvent({
      critical: true,
      actor_type: 'system',
      action: BOUNCED_ACTION,
      resource_type: 'sms',
      metadata: { sid: String(sid) },
    });
    return 1;
  } catch (err) {
    logger.error(`[one-text-per-day] tracker bounce record failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  sameTextDay,
  dayOf,
  sendTrackTextOnce,
  recordBouncedTrackText,
};
