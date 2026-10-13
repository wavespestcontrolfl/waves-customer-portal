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
 * Every read or write error fails OPEN toward the customer being informed: the
 * text goes out as it does with the gate off.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { recordAuditEvent } = require('./audit-log');
const { oneTextPerCustomerDayLive } = require('../config/feature-gates');

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
 * Every sendable, windowed service of the reference service's text day (the
 * reference included), each with its live reminder row when it has one. Empty
 * when the reference has no saved property: the rule does not apply and every
 * row keeps its own text, as before.
 */
async function loadDayRows(conn, serviceId) {
  const ref = await loadRef(conn, serviceId);
  if (!ref || !ref.property_id) return [];
  const rows = await conn('scheduled_services as ss')
    .leftJoin('appointment_reminders as ar', function liveReminderRow() {
      this.on('ar.scheduled_service_id', 'ss.id').andOn('ar.cancelled', conn.raw('false'));
    })
    .where({ 'ss.customer_id': ref.customer_id, 'ss.property_id': ref.property_id })
    .whereRaw('ss.scheduled_date between ?::date - 1 and ?::date + 1', [ref.day, ref.day])
    .whereIn('ss.status', SENDABLE_STATUSES)
    .whereNotNull('ss.window_start')
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

/**
 * Extra arrival instants the send-time slot validator accepts for a reminder
 * about `serviceId`: the earliest live arrival of its customer-day, but ONLY for
 * the merged day reminder that rendered it. That send passes `renderedDay`, the
 * ids of the members its text named. Any other caller passes nothing and gets [],
 * so a confirmation or reschedule notice quoting a sibling's time is held as
 * before. The live day must still be exactly the rendered members (a service
 * added, cancelled or dropped since means the text is stale: held, re-rendered on
 * the next scan). [] with the gate off or on any error.
 */
async function dayArrivalCandidates(serviceId, renderedDay) {
  try {
    if (!Array.isArray(renderedDay) || !oneTextPerCustomerDayLive()) return [];
    const rendered = renderedDay.map(String).sort();
    if (rendered.length < 2 || !rendered.includes(String(serviceId))) return [];
    const rows = await loadDayRows(db, serviceId);
    const live = rows.map((m) => String(m.scheduled_service_id)).sort();
    const earliest = live.length === rendered.length && live.every((id, i) => id === rendered[i])
      ? earliestArrivalMs(rows) : null;
    return earliest === null ? [] : [earliest];
  } catch {
    return [];
  }
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
    await recordAuditEvent({
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

// A sibling of the same technician, still live on this day, with a "delivered"
// row for this kind and day: proof the customer was really told.
async function deliveredSibling(trx, ref, kind) {
  const spec = TRACK_TEXTS[kind];
  const rows = await trx('audit_log as al')
    .join('scheduled_services as sib', 'sib.id', 'al.resource_id')
    .where('al.action', DELIVERED_ACTION)
    .whereRaw("al.metadata->>'kind' = ?", [kind])
    .whereRaw("al.metadata->>'day' = ?", [ref.day])
    .where({ 'sib.customer_id': ref.customer_id, 'sib.property_id': ref.property_id })
    .whereNot('sib.id', ref.id)
    .whereNotIn('sib.status', ['cancelled', 'skipped', 'rescheduled'])
    .whereIn('sib.track_state', spec.states)
    .whereRaw('sib.scheduled_date between ?::date - 1 and ?::date + 1', [ref.day, ref.day])
    .select('sib.id', 'sib.customer_id', 'sib.property_id', 'sib.technician_id',
      trx.raw("to_char(sib.scheduled_date, 'YYYY-MM-DD') as day"));
  return rows.find((r) => sameTextDay(ref, r, { sameTechnician: true })) || null;
}

async function recordTrackOutcome(trx, ref, kind, covering) {
  await recordAuditEvent({
    actor_type: 'system',
    action: covering ? `track.one_text_per_day.${kind}` : DELIVERED_ACTION,
    resource_type: 'scheduled_service',
    resource_id: ref.id,
    metadata: {
      kind, customer_id: ref.customer_id, property_id: ref.property_id, day: ref.day,
      technician_id: ref.technician_id || null,
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
 * customer, address, technician and day. With the gate on and a saved address,
 * the check and the send happen under one advisory lock, so a second tap waits
 * for the first send to finish and then sees its "delivered" row. A sender that
 * did not return success leaves no row, so the next tap sends. Returns the
 * sender's result, or COVERED_BY_DAY (a suppressed, handled result) after
 * stamping the guard and writing an audit row. Gate off, no saved address, or a
 * failure before the send: the sender runs unlocked, as without the rule.
 */
async function sendTrackTextOnce(svc, kind, sendFn, { fence = null } = {}) {
  let applies = false;
  try {
    applies = Boolean(TRACK_TEXTS[kind] && svc && svc.property_id && oneTextPerCustomerDayLive());
  } catch {
    applies = false;
  }
  if (!applies) return sendFn();
  const state = { sending: false, done: false, result: null };
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
      const covering = await deliveredSibling(trx, ref, kind);
      if (covering) {
        await stampTrackGuard(kind, fence);
        await recordTrackOutcome(trx, ref, kind, covering);
        logger.info(`[one-text-per-day] ${kind} text for ${ref.id} covered by ${covering.id} (delivered text, same customer, address, technician, day)`);
        return COVERED_BY_DAY;
      }
      const result = await send();
      if (result && result.success === true) await recordTrackOutcome(trx, ref, kind, null);
      return result;
    });
  } catch (err) {
    // The sender itself threw: its caller handles that, as without the rule.
    if (state.sending && !state.done) throw err;
    logger.error(`[one-text-per-day] ${kind} once-per-day check failed for ${svc.id} (sent as usual): ${err.message}`);
    // Bookkeeping failed after a real send: never send a second one.
    return state.sending ? state.result : sendFn();
  }
}

module.exports = {
  sameTextDay,
  dayOf,
  loadDayRows,
  earliestArrivalMs,
  dayArrivalCandidates,
  closeCoveredReminderTiers,
  sendTrackTextOnce,
};
