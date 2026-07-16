/**
 * Keep appointment_reminders in lockstep with scheduled_services at the
 * database level, so EVERY write path (admin routes, dispatch, direct SQL
 * maintenance) moves the reminder clock together with the appointment.
 *
 * Why: the reminder cron computes hoursUntil from
 * appointment_reminders.appointment_time. Application code paths call
 * AppointmentReminders.handleReschedule() to sync it, but any path that
 * updates scheduled_services without that call (raw SQL, future routes)
 * leaves appointment_time stale — the cron then sends reminders for the
 * OLD date/time or skips them entirely (2026-07-16 incident: customers
 * texted "your appointment is tomorrow" for visits moved a week out).
 *
 * The trigger mirrors handleReschedule's silent-move semantics
 * (server/services/appointment-reminders.js — sendNotification:false,
 * coverDueWindows:false):
 *   - appointment_time follows scheduled_date + window_start (ET).
 *   - 72h flag: covered (true) when the new time is already inside the
 *     72h window — firing it right after a move would announce a change
 *     the customer hasn't been told about; armed (false) when the new
 *     time is further out.
 *   - 24h flag: re-armed for any future time — a silent reshuffle must
 *     not strand the customer with no day-before reminder at all.
 *   - Terminal status (cancelled/skipped/no_show/completed) cancels the
 *     reminder; moving back to an active status re-activates it.
 *
 * Shared-slot invariant (mirrors registerVisitReminderInTx): for one
 * customer + appointment_time, exactly ONE reminder row sends and every
 * sibling is fully suppressed (both flags true), so the customer never
 * gets duplicate texts for one slot:
 *   - Arrival: a row moving onto a slot that already has an active
 *     sibling is inserted-suppressed instead of armed.
 *   - Departure: when a row leaves a slot, one fully-suppressed sibling
 *     whose service still occupies that slot is promoted (re-armed) if
 *     no armed row remains — otherwise the remaining service would
 *     silently lose its reminders. (Known cosmetic gap: the promoted /
 *     surviving row keeps its own service label; the registration-time
 *     merged label is not recomputed here.)
 * The trigger only writes appointment_reminders rows; it never sends
 * anything itself. Application updates that run after it
 * (handleReschedule) overwrite with the same or more specific values —
 * verified compatible with its startMoved/resolveFlag logic.
 */

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION sync_appointment_reminder_on_service_change()
RETURNS trigger AS $$
DECLARE
  new_appt_time timestamptz;
  old_appt_time timestamptz;
  sibling_exists boolean;
  became_terminal boolean;
  became_active boolean;
  time_changed boolean;
BEGIN
  became_terminal := NEW.status IN ('cancelled','skipped','no_show','completed')
                     AND OLD.status NOT IN ('cancelled','skipped','no_show','completed');
  became_active   := OLD.status IN ('cancelled','skipped','no_show','completed')
                     AND NEW.status IN ('pending','confirmed','rescheduled');
  time_changed    := (NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date)
                     OR (NEW.window_start IS DISTINCT FROM OLD.window_start);

  old_appt_time := ((OLD.scheduled_date + COALESCE(OLD.window_start, TIME '08:00'))::timestamp
                    AT TIME ZONE 'America/New_York');

  IF became_terminal THEN
    UPDATE appointment_reminders
       SET cancelled = true, updated_at = NOW()
     WHERE scheduled_service_id = NEW.id AND cancelled = false;
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start);
    RETURN NEW;
  END IF;

  IF time_changed OR became_active THEN
    new_appt_time := ((NEW.scheduled_date + COALESCE(NEW.window_start, TIME '08:00'))::timestamp
                      AT TIME ZONE 'America/New_York');

    -- Arrival: an active sibling already owns the destination slot -> this
    -- row must land fully suppressed (one-active-row-per-slot invariant).
    sibling_exists := EXISTS (
      SELECT 1 FROM appointment_reminders ar2
       WHERE ar2.customer_id = NEW.customer_id
         AND ar2.appointment_time = new_appt_time
         AND ar2.cancelled = false
         AND ar2.scheduled_service_id <> NEW.id);

    UPDATE appointment_reminders
       SET appointment_time = new_appt_time,
           cancelled = false,
           reminder_72h_sent = sibling_exists
                               OR (new_appt_time > NOW()
                                   AND new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes'),
           reminder_72h_sent_at = CASE
             WHEN sibling_exists
                  OR (new_appt_time > NOW()
                      AND new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes') THEN NOW()
             ELSE NULL END,
           reminder_24h_sent = sibling_exists,
           reminder_24h_sent_at = CASE WHEN sibling_exists THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE scheduled_service_id = NEW.id;

    IF time_changed THEN
      PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                  OLD.scheduled_date, OLD.window_start);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

// Departure-side helper: when a service leaves a slot (move or terminal
// status), promote ONE fully-suppressed sibling whose service still occupies
// that slot — but only when no armed row remains there. Promotion re-arms
// with the same window semantics as a move (72h covered when already due,
// 24h armed).
const PROMOTE_SQL = `
CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling(
  p_customer_id uuid, p_departing_service_id uuid, p_slot_time timestamptz,
  p_slot_date date, p_slot_window time
) RETURNS void AS $$
BEGIN
  UPDATE appointment_reminders arp
     SET reminder_72h_sent = (arp.appointment_time > NOW()
                              AND arp.appointment_time <= NOW() + INTERVAL '72 hours 15 minutes'),
         reminder_72h_sent_at = CASE
           WHEN arp.appointment_time > NOW()
                AND arp.appointment_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
           ELSE NULL END,
         reminder_24h_sent = false,
         reminder_24h_sent_at = NULL,
         updated_at = NOW()
   WHERE arp.id = (
           SELECT ar2.id
             FROM appointment_reminders ar2
             JOIN scheduled_services ss2 ON ss2.id = ar2.scheduled_service_id
            WHERE ar2.customer_id = p_customer_id
              AND ar2.appointment_time = p_slot_time
              AND ar2.cancelled = false
              AND ar2.scheduled_service_id <> p_departing_service_id
              AND ar2.reminder_72h_sent AND ar2.reminder_24h_sent
              AND ss2.status IN ('pending','confirmed','rescheduled')
              AND ss2.scheduled_date = p_slot_date
              AND COALESCE(ss2.window_start, TIME '08:00') = COALESCE(p_slot_window, TIME '08:00')
            ORDER BY ar2.created_at ASC, ar2.id ASC
            LIMIT 1)
     AND NOT EXISTS (
           SELECT 1 FROM appointment_reminders ar3
            WHERE ar3.customer_id = p_customer_id
              AND ar3.appointment_time = p_slot_time
              AND ar3.cancelled = false
              AND ar3.scheduled_service_id <> p_departing_service_id
              AND NOT (ar3.reminder_72h_sent AND ar3.reminder_24h_sent));
END;
$$ LANGUAGE plpgsql;
`;

exports.up = async function up(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  if (!hasServices || !hasReminders) return;

  await knex.raw(PROMOTE_SQL);
  await knex.raw(FUNCTION_SQL);
  await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_sync_reminder ON scheduled_services');
  await knex.raw(`
    CREATE TRIGGER scheduled_services_sync_reminder
    AFTER UPDATE OF scheduled_date, window_start, status ON scheduled_services
    FOR EACH ROW EXECUTE FUNCTION sync_appointment_reminder_on_service_change()
  `);

  // One-time backfill, statement 1: heal reminder rows that drifted BEFORE
  // the trigger existed (moves that skipped handleReschedule). Same formula
  // and flag semantics as the trigger. Scoped to future, active appointments
  // whose reminder clock disagrees with the live row — 12 rows in prod at
  // time of writing. Rows already in sync (including deliberately-suppressed
  // ones) are untouched by the IS DISTINCT FROM guard.
  await knex.raw(`
    UPDATE appointment_reminders ar
       SET appointment_time = sync.correct_time,
           reminder_72h_sent = (sync.correct_time > NOW()
                                AND sync.correct_time <= NOW() + INTERVAL '72 hours 15 minutes'),
           reminder_72h_sent_at = CASE
             WHEN sync.correct_time > NOW()
                  AND sync.correct_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
             ELSE NULL END,
           reminder_24h_sent = false,
           reminder_24h_sent_at = NULL,
           updated_at = NOW()
      FROM (
        SELECT ss.id AS service_id,
               ((ss.scheduled_date + COALESCE(ss.window_start, TIME '08:00'))::timestamp
                AT TIME ZONE 'America/New_York') AS correct_time
          FROM scheduled_services ss
         WHERE ss.status IN ('pending','confirmed','rescheduled')
           AND ss.scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
      ) sync
     WHERE sync.service_id = ar.scheduled_service_id
       AND ar.cancelled = false
       AND ar.appointment_time IS DISTINCT FROM sync.correct_time
  `);

  // Statement 2: re-assert the one-active-row-per-slot invariant for future
  // slots (a healed row can land on a slot that already has an armed row —
  // both would text). Keyed on the LIVE service slot on both sides, in a
  // separate statement, because a data-modifying CTE's sibling statements
  // read the pre-update snapshot and would miss the healed times. Keep =
  // earliest created (registration's sender), suppress the rest.
  await knex.raw(`
    UPDATE appointment_reminders dup
       SET reminder_72h_sent = true,
           reminder_72h_sent_at = COALESCE(dup.reminder_72h_sent_at, NOW()),
           reminder_24h_sent = true,
           reminder_24h_sent_at = COALESCE(dup.reminder_24h_sent_at, NOW()),
           updated_at = NOW()
      FROM scheduled_services ssd
     WHERE ssd.id = dup.scheduled_service_id
       AND dup.cancelled = false
       AND NOT (dup.reminder_72h_sent AND dup.reminder_24h_sent)
       AND ssd.status IN ('pending','confirmed','rescheduled')
       AND ssd.scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
       AND EXISTS (
             SELECT 1
               FROM appointment_reminders keep
               JOIN scheduled_services ssk ON ssk.id = keep.scheduled_service_id
              WHERE keep.customer_id = dup.customer_id
                AND keep.id <> dup.id
                AND keep.cancelled = false
                AND NOT (keep.reminder_72h_sent AND keep.reminder_24h_sent)
                AND ssk.status IN ('pending','confirmed','rescheduled')
                AND ssk.scheduled_date = ssd.scheduled_date
                AND COALESCE(ssk.window_start, TIME '08:00') = COALESCE(ssd.window_start, TIME '08:00')
                AND (keep.created_at < dup.created_at
                     OR (keep.created_at = dup.created_at AND keep.id < dup.id)))
  `);
};

exports.down = async function down(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  if (hasServices) {
    await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_sync_reminder ON scheduled_services');
  }
  await knex.raw('DROP FUNCTION IF EXISTS sync_appointment_reminder_on_service_change()');
  await knex.raw('DROP FUNCTION IF EXISTS promote_suppressed_reminder_sibling(uuid, uuid, timestamptz, date, time)');
};
