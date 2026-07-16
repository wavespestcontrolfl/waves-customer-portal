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
 *   - Terminal status (cancelled/skipped/no_show) cancels the reminder;
 *     moving back to an active status re-activates it.
 * The trigger only writes appointment_reminders rows; it never sends
 * anything itself. Application updates that run after it (handleReschedule)
 * simply overwrite with the same or more specific values — verified
 * compatible with its startMoved/resolveFlag logic.
 */

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION sync_appointment_reminder_on_service_change()
RETURNS trigger AS $$
DECLARE
  new_appt_time timestamptz;
  became_terminal boolean;
  became_active boolean;
  time_changed boolean;
BEGIN
  became_terminal := NEW.status IN ('cancelled','skipped','no_show')
                     AND OLD.status NOT IN ('cancelled','skipped','no_show');
  became_active   := OLD.status IN ('cancelled','skipped','no_show')
                     AND NEW.status IN ('pending','confirmed','rescheduled');
  time_changed    := (NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date)
                     OR (NEW.window_start IS DISTINCT FROM OLD.window_start);

  IF became_terminal THEN
    UPDATE appointment_reminders
       SET cancelled = true, updated_at = NOW()
     WHERE scheduled_service_id = NEW.id AND cancelled = false;
    RETURN NEW;
  END IF;

  IF time_changed OR became_active THEN
    new_appt_time := ((NEW.scheduled_date + COALESCE(NEW.window_start, TIME '08:00'))::timestamp
                      AT TIME ZONE 'America/New_York');
    UPDATE appointment_reminders
       SET appointment_time = new_appt_time,
           cancelled = false,
           reminder_72h_sent = (new_appt_time > NOW()
                                AND new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes'),
           reminder_72h_sent_at = CASE
             WHEN new_appt_time > NOW()
                  AND new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
             ELSE NULL END,
           reminder_24h_sent = false,
           reminder_24h_sent_at = NULL,
           updated_at = NOW()
     WHERE scheduled_service_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

exports.up = async function up(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  if (!hasServices || !hasReminders) return;

  await knex.raw(FUNCTION_SQL);
  await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_sync_reminder ON scheduled_services');
  await knex.raw(`
    CREATE TRIGGER scheduled_services_sync_reminder
    AFTER UPDATE OF scheduled_date, window_start, status ON scheduled_services
    FOR EACH ROW EXECUTE FUNCTION sync_appointment_reminder_on_service_change()
  `);
};

exports.down = async function down(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  if (hasServices) {
    await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_sync_reminder ON scheduled_services');
  }
  await knex.raw('DROP FUNCTION IF EXISTS sync_appointment_reminder_on_service_change()');
};
