/**
 * One text per customer, service address and day (GATE_ONE_TEXT_PER_CUSTOMER_DAY).
 *
 * Owner 2026-10-12: a customer with two services at one address on one day gets
 * ONE appointment reminder, ONE "on the way" text and ONE "arrived" text. The
 * rule looks at the customer, the service address (`property_id`) and the ET
 * calendar day, and nothing else. It does not read `visit_id`, `service_visits`
 * or `visit_effects`, so it keeps working when visit grouping is deleted.
 *
 * "Already told" is only ever decided from proof of a real, specific delivery:
 *
 *  - Reminders: the sender's own delivery (SMS reached, or the fallback email
 *    was accepted). After it, the SNAPSHOT that was rendered into the text (the
 *    members it named, each with the reminder time it quoted) is closed, member
 *    by member, only while that member is still on the same reminder time. A
 *    sender that moved while the send was in flight, or a service added during
 *    it, is not in the snapshot and keeps its own reminder.
 *  - Tracker texts (en route, arrived): the per-row guard columns are stamped
 *    BEFORE a send (and even when the text is disabled), so they prove nothing.
 *    `sendTrackTextOnce` runs the check and the send inside one transaction
 *    holding an advisory lock on customer + address + day + kind, so two taps
 *    cannot both stand down, and records an audit_log "delivered" row only after
 *    the sender returned success. Coverage needs that row from a sibling of the
 *    same technician, still live on the same day.
 *
 * PRINCIPLES (every rule below follows from these):
 *  - Proof of delivery is durable and written WITH the send: a tracker "delivered" row is written
 *    as a critical write in the send's own transaction, and re-written outside it if that failed.
 *    Without proof the NEXT sibling sends (a duplicate is possible); THIS visit never sends twice.
 *  - "Could not read" is never treated as "not eligible" or "already told". A render that cannot
 *    read its day sends the sender's own single-visit reminder and closes nothing. A live send
 *    that cannot validate its merged day is held and re-rendered on the next scan. A queued copy
 *    that cannot validate its day is retried (bounded); only a day proven changed is dropped.
 *  - Every named member is covered, and only named members are covered: a merged text names only
 *    members that have a live reminder row, and closure covers exactly those named.
 *
 * Every read or write error fails OPEN toward the customer being informed: the
 * text goes out as it does with the gate off.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const auditLog = require('./audit-log');
const { oneTextPerCustomerDayLive } = require('../config/feature-gates');
const { heldVisitSubquery } = require('./street-level-hold');
const { RETAINED_HISTORY_STATUSES } = require('./visit-context/statuses');

const REMINDER_TIER_COLUMNS = {
  '72h': [['reminder_72h_sent', 'reminder_72h_sent_at']],
  // A 24h delivery also supersedes a still-armed 72h reminder.
  '24h': [['reminder_72h_sent', 'reminder_72h_sent_at'], ['reminder_24h_sent', 'reminder_24h_sent_at']],
};
const SENDABLE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
const TRACK_TEXTS = {
  en_route: { stamp: 'track_sms_sent_at', states: ['en_route', 'on_property', 'complete'] },
  arrived: { stamp: 'arrival_sms_sent_at', states: ['on_property', 'complete'] },
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

async function loadRef(conn, serviceId) {
  return conn('scheduled_services')
    .where({ id: serviceId })
    .first('id', 'customer_id', 'property_id', 'technician_id', conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
}

/**
 * The MEMBERS a merged day reminder may name: every service of the reference
 * service's text day (the reference included) that its OWN single-visit reminder
 * would be allowed to send for, each with its live reminder row.
 * Empty when the reference has no saved property: the rule does not apply and
 * every row keeps its own text, as before.
 *
 * Eligibility is the single-visit reminder path's own send predicates, applied to
 * every member (at render AND at handoff, which reads this same function):
 *  - sendable status (not cancelled / skipped / completed / no_show / rescheduled):
 *    REMINDER_BLOCKING_STATUSES in appointment-reminders.js, the scan's live-status guard;
 *  - a real window (not a windowless pre-closed 08:00 placeholder): the scan's
 *    `windows_preclosed = false` and buildMergedServiceLabel's placeholder rule;
 *  - a live reminder row, past its confirmation (`confirmation_sent`): the scan only reads
 *    rows with `confirmation_sent = true`. A service with no reminder row yet (the self-heal
 *    sweep has not armed it) is NOT a member: it could not be covered, so it is not named, and
 *    it sends its own reminder once armed;
 *  - no live `move_hold_until` on its reminder row: the scan's own WHERE and the
 *    send-time guard visit-groups appointmentSendHeld (holdLive);
 *  - not a street-level address hold awaiting the office confirm
 *    (street-level-hold heldVisitSubquery): the scan's guard, the self-heal sweep, and
 *    the send step STREET_LEVEL_HOLD in send-customer-message.
 * A held member is left out: it is not named, not quoted, not closed, and stays
 * armed to send its own reminder once released. The customer-level holds (deleted
 * customer, the disclaimed-number callback hold) are the same for every member of
 * one customer and are applied to the merged send itself at the send boundary.
 */
async function loadDayRows(conn, serviceId) {
  const ref = await loadRef(conn, serviceId);
  if (!ref || !ref.property_id) return [];
  const rows = await conn('scheduled_services as ss')
    .join('appointment_reminders as ar', function liveReminderRow() {
      this.on('ar.scheduled_service_id', 'ss.id').andOn('ar.cancelled', conn.raw('false'));
    })
    .where({ 'ss.customer_id': ref.customer_id, 'ss.property_id': ref.property_id })
    .whereRaw('ss.scheduled_date between ?::date - 1 and ?::date + 1', [ref.day, ref.day])
    .whereIn('ss.status', SENDABLE_STATUSES)
    .whereNotNull('ss.window_start')
    .where('ar.confirmation_sent', true)
    .where('ar.windows_preclosed', false)
    .where(function notMoveHeld() { this.whereNull('ar.move_hold_until').orWhere('ar.move_hold_until', '<', new Date()); })
    .whereNotExists(function notAddressHeld() { heldVisitSubquery(this, 'ss'); })
    .orderBy('ss.window_start', 'asc')
    .orderBy('ss.id', 'asc')
    .select(
      'ss.id as scheduled_service_id', 'ss.customer_id', 'ss.property_id', 'ss.technician_id',
      'ss.service_type', 'ss.scheduled_date', 'ss.window_start',
      conn.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as day"),
      'ar.id as reminder_id', 'ar.appointment_time', 'ar.windows_preclosed',
      'ar.reminder_72h_sent', 'ar.reminder_24h_sent',
    );
  return rows.filter((m) => sameTextDay(ref, m));
}

// Arrival instant a member's reminder quotes: its reminder row's time, else its
// date + window start. The copy a reminder renders and the slot validator
// (visit-groups appointmentSendHeld) both read THIS, so the validator accepts
// exactly the earliest arrival the text states.
function memberArrivalMs(m) {
  if (!m || m.windows_preclosed === true) return null;
  let at = null;
  if (m.appointment_time) at = new Date(m.appointment_time);
  else if (m.day && m.window_start) at = parseETDateTime(`${m.day}T${String(m.window_start).slice(0, 8)}`);
  return at && !Number.isNaN(at.getTime()) ? at.getTime() : null;
}

function earliestArrivalMs(rows) {
  const times = (Array.isArray(rows) ? rows : []).map(memberArrivalMs).filter((ms) => ms !== null);
  return times.length ? Math.min(...times) : null;
}

// The token a merged day reminder carries to the send boundary: one `id@arrival-ms` per
// member the text named, as read when it was rendered.
function renderedDayToken(rows) {
  return (Array.isArray(rows) ? rows : []).map((m) => `${m.scheduled_service_id}@${memberArrivalMs(m)}`);
}

/**
 * THE validator for a merged day reminder (visit-groups appointmentSendHeld calls it for
 * every send that carries the rendered-day token, and for no other send).
 *
 * INVARIANT: a merged day reminder is handed to the provider only if, at handoff, every
 * member it names is still live on that day at the quoted time, is not under any hold that
 * would defer its own reminder (loadDayRows' predicates), and the member set is exactly
 * what was rendered. Otherwise the merged send is held (nothing goes) and the next scan
 * re-renders. A member is closed only after such a delivery (closeCoveredReminderTiers).
 *
 * Returns the one arrival instant (the day's earliest) the text may quote, or [] when the
 * token is not a valid, current rendering of this service's day: the caller then holds the
 * send. No ordinary slot candidate (the sender's own arrival, a visit stop start) can rescue
 * a token that fails here. [] with the gate off or on any error (fail closed for this send).
 */
async function dayArrivalCandidates(serviceId, renderedDay) {
  const verdict = await mergedDayVerdict(serviceId, renderedDay);
  return verdict.state === 'valid' ? [verdict.earliest] : [];
}

/**
 * The merged-day check with "could not read" kept apart from "changed":
 *   { state: 'valid', earliest }  the token is a current rendering of this service's day
 *   { state: 'changed' }          the day is proven different (or the gate is off): terminal
 *   { state: 'unreadable' }       the day could not be read: never a verdict on the day
 * dayArrivalCandidates (the live send boundary) holds the send for both non-valid states and the
 * next scan re-renders; recheckMergedDay (a queued copy) retries 'unreadable' and drops only
 * 'changed'.
 */
async function mergedDayVerdict(serviceId, renderedDay) {
  try {
    if (!Array.isArray(renderedDay) || !oneTextPerCustomerDayLive()) return { state: 'changed' };
    const rendered = renderedDay.map(String).sort();
    if (rendered.length < 2 || !rendered.some((t) => t.startsWith(`${serviceId}@`))) return { state: 'changed' };
    const rows = await loadDayRows(db, serviceId);
    const live = renderedDayToken(rows).sort();
    const same = live.length === rendered.length && live.every((t, i) => t === rendered[i]);
    const earliest = same ? earliestArrivalMs(rows) : null;
    return earliest === null ? { state: 'changed' } : { state: 'valid', earliest };
  } catch (err) {
    logger.warn(`[one-text-per-day] merged day for ${serviceId} could not be read (${err.code || err.name || 'error'}): not treated as changed`);
    return { state: 'unreadable' };
  }
}

/**
 * Re-check for a merged day reminder that was frozen into the deferred-contact queue (a
 * partial fan-out held at 20:00; deferred-replay-registry appointment_notice_contact_deferred),
 * run early by the executor and again at the provider boundary. The queued row carries the
 * token and the slot it was rendered with. Null = not a merged reminder, or still valid (the
 * same validator as the live send). A day proven changed is the terminal verdict; a day that
 * could not be read is retryable (the executor's bounded retry), never a drop.
 */
async function recheckMergedDay(meta) {
  if (!meta || !Array.isArray(meta.rendered_day_members)) return null;
  const verdict = await mergedDayVerdict(meta.scheduled_service_id, meta.rendered_day_members);
  if (verdict.state === 'unreadable') return { eligible: false, retryable: true, reason: 'merged-day-unreadable' };
  return verdict.state === 'valid' && verdict.earliest === Number(meta.rendered_slot_ms) ? null : { eligible: false, reason: 'merged-day-changed' };
}

// The row is still on the reminder time the text quoted for it.
async function closeSiblingTiers(m, columns, tier, sender) {
  const patch = {};
  const query = db('appointment_reminders')
    .where({ id: m.reminder_id, cancelled: false })
    .where('appointment_time', m.appointment_time);
  const now = new Date();
  for (const [flag, flagAt] of columns) {
    if (m[flag] === true) continue;
    patch[flag] = true;
    patch[flagAt] = now;
    query.where(flag, false);
  }
  if (!Object.keys(patch).length) return 0;
  const closed = await query.update(patch);
  if (closed > 0) {
    await auditLog.recordAuditEvent({
      actor_type: 'system',
      action: 'reminder.one_text_per_day.covered',
      resource_type: 'scheduled_service',
      resource_id: m.scheduled_service_id,
      metadata: {
        tier,
        covered_by_scheduled_service_id: sender.scheduled_service_id,
        customer_id: sender.customer_id,
        day: m.day,
        closed: Object.keys(patch).filter((k) => !k.endsWith('_at')),
      },
    });
  }
  return closed;
}

/**
 * After a reminder tier was really delivered for `row` (an appointment_reminders
 * row; `delivered` false does nothing), close that tier on the OTHER members of
 * `snapshot`: the day's rows exactly as they were read when the text was
 * rendered. A member is closed only while it is still on the reminder time it
 * was rendered with; a sender that moved, or a service added, after the render
 * is not in the snapshot or no longer matches, so it keeps its own reminder. No
 * snapshot (gate off, one service, unreadable) closes nothing. Never throws: a
 * failure leaves the siblings armed, and they text on their own (never silent).
 */
async function closeCoveredReminderTiers(row, tier, delivered = true, snapshot = null) {
  const columns = REMINDER_TIER_COLUMNS[tier];
  if (!delivered || !columns || !row || !row.scheduled_service_id || !Array.isArray(snapshot)) return 0;
  try {
    if (!oneTextPerCustomerDayLive()) return 0;
    let closed = 0;
    for (const m of snapshot) {
      if (m.scheduled_service_id === row.scheduled_service_id || !m.reminder_id) continue;
      if (m.windows_preclosed === true) continue;
      closed += await closeSiblingTiers(m, columns, tier, row);
    }
    if (closed > 0) logger.info(`[one-text-per-day] ${tier} reminder for ${row.scheduled_service_id} covered ${closed} other row(s) of the same customer-day`);
    return closed;
  } catch (err) {
    logger.error(`[one-text-per-day] ${tier} sibling close failed for ${row.scheduled_service_id} (siblings stay armed): ${err.message}`);
    return 0;
  }
}

// ---- Tracker texts (en route, arrived) -------------------------------------

async function stampTrackGuard(kind, fence) {
  // Arrival already holds its guard (the CAS claim). En route stamps the covered
  // row the way the visit fan-out's "covered" stamp does, fenced to the attempt.
  if (kind !== 'en_route' || !fence) return;
  await db('scheduled_services').where(fence).whereNull(TRACK_TEXTS[kind].stamp).update({ [TRACK_TEXTS[kind].stamp]: new Date() });
}

// A sibling, still live on this day, with a "delivered" row for this kind and day that
// NAMED the same person: proof the customer was really told by that technician. The person
// is the one recorded on the delivered row (the technician the text named, which for an
// arrival can be the one who actually arrived, not the scheduled one), compared with the
// one this text would name. The sibling's own assignment is mutable and is never read.
async function deliveredSibling(trx, ref, kind, technicianId) {
  const spec = TRACK_TEXTS[kind];
  const rows = await trx('audit_log as al')
    .join('scheduled_services as sib', 'sib.id', 'al.resource_id')
    .where('al.action', DELIVERED_ACTION)
    .whereRaw("al.metadata->>'kind' = ?", [kind])
    .whereRaw("al.metadata->>'day' = ?", [ref.day])
    .where({ 'sib.customer_id': ref.customer_id, 'sib.property_id': ref.property_id })
    .whereNot('sib.id', ref.id)
    // A visit that did not happen (cancelled, skipped, no-show, awaiting re-placement) told the customer
    // nothing about THIS service: the canonical non-performed list. A completed visit still covers.
    .whereNotIn('sib.status', RETAINED_HISTORY_STATUSES)
    .whereIn('sib.track_state', spec.states)
    .whereRaw('sib.scheduled_date between ?::date - 1 and ?::date + 1', [ref.day, ref.day])
    .select('sib.id', 'sib.customer_id', 'sib.property_id',
      trx.raw("al.metadata->>'technician_id' as delivered_technician_id"),
      trx.raw("to_char(sib.scheduled_date, 'YYYY-MM-DD') as day"));
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
 * did not return success leaves no row, so the next tap sends. Returns the
 * sender's result, or COVERED_BY_DAY (a suppressed, handled result) after
 * stamping the guard and writing an audit row. Gate off, no saved address, or a
 * failure before the send: the sender runs unlocked, as without the rule.
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
  const send = async () => {
    state.sending = true;
    state.result = await sendFn();
    state.done = true;
    return state.result;
  };
  try {
    return await db.transaction(async (trx) => {
      const ref = await loadRef(trx, svc.id);
      if (!ref) return send();
      await lockTrackDay(trx, ref, kind);
      const named = technicianId || ref.technician_id;
      const covering = await deliveredSibling(trx, ref, kind, named);
      if (covering) {
        await stampTrackGuard(kind, fence);
        await recordTrackOutcome(trx, ref, kind, covering, named);
        logger.info(`[one-text-per-day] ${kind} text for ${ref.id} covered by ${covering.id} (delivered text, same customer, address, technician, day)`);
        return COVERED_BY_DAY;
      }
      const result = await send();
      state.proof = result && result.success === true ? { ref, named } : null;
      // CRITICAL write: a database error must surface here, not be swallowed (the row is the only proof).
      if (state.proof) await recordTrackOutcome(trx, ref, kind, null, named, { critical: true });
      return result;
    });
  } catch (err) {
    // The sender itself threw: its caller handles that, as without the rule.
    if (state.sending && !state.done) throw err;
    logger.error(`[one-text-per-day] ${kind} once-per-day bookkeeping failed for ${svc.id}: ${err.message}`);
    // Bookkeeping failed AFTER a real send: never send a second one for this visit, and keep the proof.
    if (state.sending) return rescueDeliveryProof(state, kind);
    return sendFn();
  }
}

// The text is already out but its proof row did not commit (the insert failed, or the transaction
// did): write it again outside that transaction. If that also fails, say so loudly: this visit's
// text stands as delivered, and the NEXT same-day sibling will send (a possible duplicate, never a
// silence).
async function rescueDeliveryProof(state, kind) {
  if (!state.proof) return state.result;
  try {
    await recordTrackOutcome(null, state.proof.ref, kind, null, state.proof.named, { critical: true });
  } catch (err) {
    logger.error(`[one-text-per-day] DELIVERY PROOF NOT RECORDED for ${kind} text of ${state.proof.ref.id} (${err.code || err.name || 'error'}): the next same-day sibling will send`);
  }
  return state.result;
}

module.exports = {
  sameTextDay,
  dayOf,
  loadDayRows,
  earliestArrivalMs,
  renderedDayToken,
  dayArrivalCandidates,
  recheckMergedDay,
  closeCoveredReminderTiers,
  sendTrackTextOnce,
};
