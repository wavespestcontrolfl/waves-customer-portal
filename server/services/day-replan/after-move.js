/**
 * What the app does after a visit's window moves that the day re-plan's one transaction does not (apply.js). These
 * are the rebooker's post-commit steps for a same-day, same-technician window change by an automatic writer, plus the
 * /book snapshot the customer's confirmation page reads. Each runs on its own and is best-effort: the day is
 * already committed, and every step is idempotent, so the next run repairs a visit whose step failed (repairMoved).
 * Nothing here sends anything to a customer or a technician.
 */
const logger = require('../logger');

// The end the booked window holds: its own end, else its start plus the estimated duration, else 60 minutes.
const END_SQL = "COALESCE(s.window_end, s.window_start + ((COALESCE(NULLIF(s.estimated_duration_minutes, 0), 60)::text || ' minutes')::interval))";

/**
 * A self-booked visit's /book snapshot (the confirmation-code page reads it) follows the visit's own row, the way
 * sms-scheduling-act.js syncSelfBooking keeps it. Written from the row as it is now; a row that already matches is
 * not touched.
 */
async function syncSelfBooking(conn, id) {
  await conn.raw(
    `UPDATE self_booked_appointments sb
        SET date = s.scheduled_date, start_time = s.window_start, end_time = ${END_SQL}, technician_id = s.technician_id, updated_at = now()
       FROM scheduled_services s
      WHERE s.id = ? AND sb.id = s.self_booking_id AND s.window_start IS NOT NULL
        AND (sb.date IS DISTINCT FROM s.scheduled_date OR sb.start_time IS DISTINCT FROM s.window_start
          OR sb.end_time IS DISTINCT FROM ${END_SQL} OR sb.technician_id IS DISTINCT FROM s.technician_id)`,
    [id],
  );
}

/** The visit-group seam (visit-groups.js handleChildStopChanged): a visit alone in its record keeps the record's window in step. */
async function visitSeam(conn, id) {
  const row = await conn('scheduled_services').where({ id }).first('visit_id');
  if (row && row.visit_id) await require('../visit-groups').handleChildStopChanged(id);
}

/** A legacy outbound-review row moved here would otherwise stay unactivated (rebooker.js does this after every move; at-most-once). */
async function legacyActivation(conn, id) {
  const { activateLegacyOutboundReviewRowIfNeeded } = require('../outbound-review-confirm');
  await activateLegacyOutboundReviewRowIfNeeded(conn, id, 'day-replan');
}

/** The rebooker's escalation count: a visit moved this many times is flagged for a person to review. */
async function escalationCheck(conn, id) {
  const RULES = require('../../config/reschedule-rules');
  const count = await conn('reschedule_log').where({ scheduled_service_id: id }).count('* as count').first();
  if (parseInt(count.count, 10) < RULES.escalation.max_auto_reschedules_per_service) return;
  logger.warn(`[day-replan] service ${id} has been rescheduled ${count.count} times - needs manual review`);
  const last = await conn('reschedule_log').where({ scheduled_service_id: id }).orderBy('created_at', 'desc').first();
  if (last) await conn('reschedule_log').where({ id: last.id }).update({ escalated: true });
}

async function each(label, id, fn) {
  try {
    await fn();
  } catch (err) {
    logger.warn(`[day-replan] ${label} failed for visit ${id} (the day is committed): ${err.message}`);
  }
}

/** After the commit: every moved visit's records, then one schedule-quality refresh for the date. */
async function afterMoveEffects(conn, { dateStr, written }) {
  for (const w of written) {
    await each('self-booking snapshot', w.id, () => syncSelfBooking(conn, w.id));
    await each('visit-group seam', w.id, () => visitSeam(conn, w.id));
    await each('legacy activation', w.id, () => legacyActivation(conn, w.id));
    await each('escalation check', w.id, () => escalationCheck(conn, w.id));
  }
  if (written.length === 0) return;
  await each('schedule-quality refresh', written[0].id, () => require('../scheduling/quality-after-change')
    .refreshScheduleQualityAfterChange({ jobId: written[0].id, dates: [dateStr] }));
}

/** The next run's repair of one moved visit: the records above that follow the row, never a count or a flag. */
async function repairMoved(conn, id) {
  await syncSelfBooking(conn, id);
  await visitSeam(conn, id);
}

module.exports = { afterMoveEffects, repairMoved, syncSelfBooking };
