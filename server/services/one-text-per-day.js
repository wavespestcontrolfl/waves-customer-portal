/**
 * One text per customer, service address and day (GATE_ONE_TEXT_PER_CUSTOMER_DAY).
 *
 * Owner 2026-10-12: a customer with two services at one address on one day gets
 * ONE appointment reminder, ONE "on the way" text and ONE "arrived" text. The
 * rule looks at the customer, the service address (`property_id`) and the ET
 * calendar day, and nothing else. It does not read `visit_id`, `service_visits`
 * or `visit_effects`, so it keeps working when visit grouping is deleted.
 *
 * Reminders: the first reminder that is really delivered for a tier closes the
 * same tier on every other live reminder row of that customer-property-day
 * (the same durable `reminder_*_sent` flags every other skip writes) and leaves
 * an audit_log row per closed sibling. The sender's text carries the merged
 * service label and the day's earliest arrival (appointment-reminders.js reads
 * `loadDayRows`). A visit added after the text went keeps its own armed row and
 * sends its own reminder: the rule only closes rows that existed at delivery.
 *
 * Tracker texts (en route, arrived): a sibling with the same technician whose
 * guard column is already stamped for the day means the customer was told. The
 * second visit's guard is stamped (as the visit-fan-out "covered" stamp does)
 * and an audit_log row is written.
 *
 * Every read or write error fails OPEN toward the customer being informed: the
 * text goes out as it does with the gate off. Nothing here ever suppresses the
 * only text of the day: reminders close siblings only AFTER a delivery, and a
 * tracker text is covered only by a sibling guard stamped for the same day.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
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
 * row; `delivered` false does nothing), close that tier on the day's other live reminder rows so they send
 * nothing more. No-op with the gate off. Never throws: a failure leaves the
 * siblings armed, and they text on their own (never silent).
 */
async function closeCoveredReminderTiers(row, tier, delivered = true) {
  const columns = REMINDER_TIER_COLUMNS[tier];
  if (!delivered || !columns || !row || !row.scheduled_service_id) return 0;
  try {
    if (!oneTextPerCustomerDayLive()) return 0;
    const members = await loadDayRows(db, row.scheduled_service_id);
    let closed = 0;
    for (const m of members) {
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

async function stampTrackGuard(kind, fence) {
  // Arrival already holds its guard (the CAS claim). En route stamps the covered
  // row the way the visit fan-out's "covered" stamp does, fenced to the attempt.
  if (kind !== 'en_route' || !fence) return;
  await db('scheduled_services').where(fence).whereNull(TRACK_TEXTS[kind].stamp).update({ [TRACK_TEXTS[kind].stamp]: new Date() });
}

/**
 * True when the customer was already texted this kind ("en_route" or "arrived")
 * today for another service at the same address with the same technician. Then
 * the caller sends nothing for `svc`; this stamps the guard and writes the audit
 * row. Gate off, no saved property, no such sibling, or any error: false (send).
 */
async function trackTextCoveredByDay(svc, kind, { fence = null } = {}) {
  const spec = TRACK_TEXTS[kind];
  if (!spec || !svc || !svc.property_id) return false;
  try {
    if (!oneTextPerCustomerDayLive()) return false;
    const ref = await loadRef(db, svc.id);
    if (!ref) return false;
    const siblings = await db('scheduled_services as sib')
      .where({ 'sib.customer_id': ref.customer_id, 'sib.property_id': ref.property_id })
      .whereNot('sib.id', ref.id)
      .whereNotIn('sib.status', ['cancelled', 'skipped', 'rescheduled'])
      .whereIn('sib.track_state', spec.states)
      .whereNotNull(`sib.${spec.stamp}`)
      .whereRaw(`(sib.${spec.stamp} AT TIME ZONE 'America/New_York')::date >= sib.scheduled_date`)
      .whereRaw('sib.scheduled_date between ?::date - 1 and ?::date + 1', [ref.day, ref.day])
      .select('sib.id', 'sib.customer_id', 'sib.property_id', 'sib.technician_id',
        db.raw("to_char(sib.scheduled_date, 'YYYY-MM-DD') as day"));
    const covering = siblings.find((s) => sameTextDay(ref, s, { sameTechnician: true }));
    if (!covering) return false;
    await stampTrackGuard(kind, fence);
    await recordAuditEvent({
      actor_type: 'system',
      action: `track.one_text_per_day.${kind}`,
      resource_type: 'scheduled_service',
      resource_id: ref.id,
      metadata: { covered_by_scheduled_service_id: covering.id, customer_id: ref.customer_id, day: ref.day },
    });
    logger.info(`[one-text-per-day] ${kind} text for ${ref.id} covered by ${covering.id} (same customer, address, technician, day)`);
    return true;
  } catch (err) {
    logger.error(`[one-text-per-day] ${kind} coverage check failed for ${svc.id} (sending as usual): ${err.message}`);
    return false;
  }
}

module.exports = {
  sameTextDay,
  dayOf,
  loadDayRows,
  closeCoveredReminderTiers,
  trackTextCoveredByDay,
};
