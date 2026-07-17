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
 * Window semantics on a synced move (mirrors handleReschedule's
 * silent-move path — sendNotification:false, coverDueWindows:false):
 *   - appointment_time follows scheduled_date + window_start (ET).
 *   - 72h flag: covered (true) when the new time is already inside the
 *     72h window; armed (false) when further out.
 *   - 24h flag: re-armed for any future time — a silent reshuffle must
 *     not strand the customer with no day-before reminder at all.
 *   - A terminal NEW.status (cancelled/skipped/no_show/completed) cancels
 *     the reminder; time edits on an already-terminal service are ignored
 *     (never resurrect a cancelled reminder). Moving back to an active
 *     status re-activates.
 *
 * Shared-slot invariant (mirrors registerVisitReminderInTx /
 * registerAppointment): for one customer + appointment_time, exactly ONE
 * reminder row sends; siblings are suppressed. Suppression is recorded in
 * the durable `suppressed_by_sibling` column this migration adds —
 * inferring it from the sent flags is ambiguous (a sender that already
 * delivered both reminders looks identical to a suppressed sibling).
 *   - Arrival: a row moving onto a slot that already has an active OWNER
 *     (non-suppressed row whose live service is pending/confirmed —
 *     'rescheduled' pending-rebook markers and terminal rows can't own a
 *     slot; the cron refuses to send for them) lands suppressed.
 *   - Departure (move or terminal): one suppressed sibling whose service
 *     still occupies the slot is promoted when no owner remains.
 *   - Concurrent arrivals serialize on the same pg_advisory_xact_lock key
 *     the registration path uses.
 *   (Known cosmetic gap: the promoted / surviving row keeps its own
 *   service label; the registration-time merged label is not recomputed.)
 * The trigger only writes appointment_reminders rows; it never sends
 * anything itself.
 */

// MOVABLE: statuses whose date/window edits must sync the reminder row —
// everything the schedule tools can move, including in-progress visits
// (IB schedule tools move en_route/on_site rows while preserving status).
// SENDABLE: statuses the cron will actually deliver for (everything except
// REMINDER_BLOCKING_STATUSES = terminals + 'rescheduled') — only these can
// own a shared slot or be promoted into ownership.
const MOVABLE_SERVICE = `('pending','confirmed','rescheduled','en_route','on_site')`;
const SENDABLE_SERVICE = `('pending','confirmed','en_route','on_site')`;
const TERMINAL_SERVICE = `('cancelled','skipped','no_show','completed')`;

// Serialization key — MUST match registerAppointment/registerVisitReminderInTx:
// `appointment-reminder:${customerId}:${apptTime.toISOString()}`
const LOCK_KEY_SQL = `
CREATE OR REPLACE FUNCTION reminder_slot_lock_key(p_customer_id uuid, p_time timestamptz)
RETURNS integer AS $$
  SELECT hashtext('appointment-reminder:' || p_customer_id || ':' ||
                  to_char(p_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$ LANGUAGE sql IMMUTABLE;
`;

const PROMOTE_SQL = `
CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling(
  p_customer_id uuid, p_departing_service_id uuid, p_slot_time timestamptz,
  p_slot_date date, p_slot_window time
) RETURNS void AS $$
BEGIN
  -- Promote ONE suppressed sibling whose service still occupies the slot,
  -- but only when no active owner remains there. Only rows explicitly
  -- marked suppressed_by_sibling are candidates — a sender that genuinely
  -- delivered its reminders is never re-armed.
  UPDATE appointment_reminders arp
     SET suppressed_by_sibling = false,
         -- Past-or-due times close the window (a flag left false on a past
         -- appointment keeps the row in every cron scan forever); only a
         -- genuinely future 24h window re-arms.
         reminder_72h_sent = (arp.appointment_time <= NOW() + INTERVAL '72 hours 15 minutes'),
         reminder_72h_sent_at = CASE
           WHEN arp.appointment_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
           ELSE NULL END,
         reminder_24h_sent = (arp.appointment_time <= NOW()),
         reminder_24h_sent_at = CASE WHEN arp.appointment_time <= NOW() THEN NOW() ELSE NULL END,
         updated_at = NOW()
   WHERE arp.id = (
           SELECT ar2.id
             FROM appointment_reminders ar2
             JOIN scheduled_services ss2 ON ss2.id = ar2.scheduled_service_id
            WHERE ar2.customer_id = p_customer_id
              AND ar2.appointment_time = p_slot_time
              AND ar2.cancelled = false
              AND ar2.suppressed_by_sibling = true
              AND ar2.scheduled_service_id <> p_departing_service_id
              AND ss2.status IN ${SENDABLE_SERVICE}
              AND ss2.scheduled_date = p_slot_date
              AND COALESCE(ss2.window_start, TIME '08:00') = COALESCE(p_slot_window, TIME '08:00')
            ORDER BY ar2.created_at ASC, ar2.id ASC
            LIMIT 1)
     AND NOT EXISTS (
           SELECT 1
             FROM appointment_reminders ar3
             JOIN scheduled_services ss3 ON ss3.id = ar3.scheduled_service_id
            WHERE ar3.customer_id = p_customer_id
              AND ar3.appointment_time = p_slot_time
              AND ar3.cancelled = false
              AND ar3.suppressed_by_sibling = false
              AND ar3.scheduled_service_id <> p_departing_service_id
              AND ss3.status IN ${SENDABLE_SERVICE});
END;
$$ LANGUAGE plpgsql;
`;

// Rolling-deploy protection: an old app replica (pre-marker code) can insert
// a legacy-shape suppressed sibling AFTER the one-time backfill ran — its
// insert omits the column, defaulting to false, and the row would then be
// invisible to promotion forever. Derive the marker at insert time from the
// same fingerprint the backfill uses (identical confirmation/72h/24h stamps +
// an active same-slot sibling). New-code suppressed inserts set the column
// explicitly, so this only fires for legacy-shape rows; a false positive is
// only possible for an already-past appointment, where suppression is moot.
const LEGACY_MARKER_SQL = `
CREATE OR REPLACE FUNCTION mark_legacy_suppressed_reminder_insert()
RETURNS trigger AS $$
BEGIN
  IF NOT NEW.suppressed_by_sibling
     AND NEW.cancelled = false
     AND NEW.confirmation_sent AND NEW.reminder_72h_sent AND NEW.reminder_24h_sent
     AND NEW.reminder_72h_sent_at IS NOT NULL
     AND NEW.reminder_72h_sent_at = NEW.reminder_24h_sent_at
     AND NEW.reminder_72h_sent_at = NEW.confirmation_sent_at
     AND EXISTS (
           SELECT 1 FROM appointment_reminders sib
            WHERE sib.customer_id = NEW.customer_id
              AND sib.appointment_time = NEW.appointment_time
              AND sib.cancelled = false
              AND sib.id IS DISTINCT FROM NEW.id) THEN
    NEW.suppressed_by_sibling := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION sync_appointment_reminder_on_service_change()
RETURNS trigger AS $$
DECLARE
  new_appt_time timestamptz;
  old_appt_time timestamptz;
  owner_exists boolean;
  became_terminal boolean;
  became_active boolean;
  became_sendable boolean;
  entered_rescheduled boolean;
  time_changed boolean;
  l_new integer;
  l_old integer;
BEGIN
  became_terminal := NEW.status IN ${TERMINAL_SERVICE}
                     AND OLD.status NOT IN ${TERMINAL_SERVICE};
  became_active   := OLD.status IN ${TERMINAL_SERVICE}
                     AND NEW.status IN ${MOVABLE_SERVICE};
  -- A 'rescheduled' pending-rebook marker can't own a slot, so while it sat
  -- in that status another row may have become the owner. When it turns
  -- sendable again (e.g. the customer confirms in place) its ownership must
  -- be re-decided or two armed rows share the slot.
  became_sendable := OLD.status = 'rescheduled'
                     AND NEW.status IN ${SENDABLE_SERVICE};
  -- The mirror transition: an owner entering 'rescheduled' (customer
  -- requested a new time) becomes cron-blocked without moving, so a
  -- suppressed sibling sharing its slot would otherwise be stranded with
  -- no sendable reminder. Treat it as a slot departure.
  entered_rescheduled := OLD.status IN ${SENDABLE_SERVICE}
                         AND NEW.status = 'rescheduled';
  time_changed    := (NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date)
                     OR (NEW.window_start IS DISTINCT FROM OLD.window_start);

  old_appt_time := ((OLD.scheduled_date + COALESCE(OLD.window_start, TIME '08:00'))::timestamp
                    AT TIME ZONE 'America/New_York');

  IF became_terminal THEN
    UPDATE appointment_reminders
       SET cancelled = true, updated_at = NOW()
     WHERE scheduled_service_id = NEW.id AND cancelled = false;
    -- Serialize with registration on the vacated slot: an in-flight
    -- registration may have observed this owner and be inserting a
    -- suppressed sibling this promotion can't see yet.
    PERFORM pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time));
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start);
    RETURN NEW;
  END IF;

  -- Time edits on a service that is (and stays) terminal must not resurrect
  -- its cancelled reminder.
  IF NEW.status NOT IN ${MOVABLE_SERVICE} THEN
    RETURN NEW;
  END IF;

  IF time_changed OR became_active OR became_sendable THEN
    new_appt_time := ((NEW.scheduled_date + COALESCE(NEW.window_start, TIME '08:00'))::timestamp
                      AT TIME ZONE 'America/New_York');

    -- Serialize with concurrent arrivals/departures AND the app registration
    -- path. Both slot keys are taken in canonical order so two opposite
    -- simultaneous swaps (A: S->T, B: T->S) cannot deadlock.
    l_new := reminder_slot_lock_key(NEW.customer_id, new_appt_time);
    IF time_changed THEN
      l_old := reminder_slot_lock_key(NEW.customer_id, old_appt_time);
      PERFORM pg_advisory_xact_lock(LEAST(l_new, l_old));
      IF l_new <> l_old THEN
        PERFORM pg_advisory_xact_lock(GREATEST(l_new, l_old));
      END IF;
    ELSE
      PERFORM pg_advisory_xact_lock(l_new);
    END IF;

    -- Arrival: does an active owner already hold the destination slot?
    -- Only a non-suppressed row whose live service is sendable counts —
    -- 'rescheduled' pending-rebook markers and terminal rows are skipped by
    -- the cron and must not swallow the incoming row's reminders.
    owner_exists := EXISTS (
      SELECT 1
        FROM appointment_reminders ar2
        JOIN scheduled_services ss2 ON ss2.id = ar2.scheduled_service_id
       WHERE ar2.customer_id = NEW.customer_id
         AND ar2.appointment_time = new_appt_time
         AND ar2.cancelled = false
         AND ar2.suppressed_by_sibling = false
         AND ar2.scheduled_service_id <> NEW.id
         AND ss2.status IN ${SENDABLE_SERVICE});

    UPDATE appointment_reminders
       SET appointment_time = new_appt_time,
           cancelled = false,
           suppressed_by_sibling = owner_exists,
           -- Past-or-due times close the window (an armed flag on a past
           -- appointment keeps the row in every cron scan forever).
           reminder_72h_sent = owner_exists
                               OR new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes',
           reminder_72h_sent_at = CASE
             WHEN owner_exists
                  OR new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
             ELSE NULL END,
           reminder_24h_sent = owner_exists OR new_appt_time <= NOW(),
           reminder_24h_sent_at = CASE
             WHEN owner_exists OR new_appt_time <= NOW() THEN NOW()
             ELSE NULL END,
           updated_at = NOW()
     WHERE scheduled_service_id = NEW.id;

    IF time_changed THEN
      PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                  OLD.scheduled_date, OLD.window_start);
    END IF;
  END IF;

  -- Owner entered 'rescheduled' in place (no move): its slot departure was
  -- not handled above, so promote a suppressed sibling there. When the move
  -- and the status change happen together, the time_changed branch already
  -- promoted at the old slot.
  IF entered_rescheduled AND NOT time_changed THEN
    PERFORM pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time));
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

exports.up = async function up(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  if (!hasServices || !hasReminders) return;

  // 1. Durable suppression marker.
  const hasCol = await knex.schema.hasColumn('appointment_reminders', 'suppressed_by_sibling');
  if (!hasCol) {
    await knex.schema.alterTable('appointment_reminders', (t) => {
      t.boolean('suppressed_by_sibling').notNullable().defaultTo(false);
    });
  }

  // 2. Marker backfill for rows registration suppressed before the column
  // existed. Fingerprint: the suppressed insert stamps confirmation/72h/24h
  // with one identical timestamp (a real sender's 72h and 24h are sent ~48h
  // apart), plus an active same-slot sibling must exist.
  await knex.raw(`
    UPDATE appointment_reminders ar
       SET suppressed_by_sibling = true, updated_at = NOW()
     WHERE ar.cancelled = false
       AND ar.suppressed_by_sibling = false
       AND ar.reminder_72h_sent AND ar.reminder_24h_sent AND ar.confirmation_sent
       AND ar.reminder_72h_sent_at IS NOT NULL
       AND ar.reminder_72h_sent_at = ar.reminder_24h_sent_at
       AND ar.reminder_72h_sent_at = ar.confirmation_sent_at
       AND EXISTS (
             SELECT 1 FROM appointment_reminders sib
              WHERE sib.customer_id = ar.customer_id
                AND sib.appointment_time = ar.appointment_time
                AND sib.cancelled = false
                AND sib.id <> ar.id)
  `);

  await knex.raw(LOCK_KEY_SQL);
  await knex.raw(PROMOTE_SQL);
  await knex.raw(FUNCTION_SQL);
  await knex.raw(LEGACY_MARKER_SQL);
  await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_sync_reminder ON scheduled_services');
  await knex.raw(`
    CREATE TRIGGER scheduled_services_sync_reminder
    AFTER UPDATE OF scheduled_date, window_start, status ON scheduled_services
    FOR EACH ROW EXECUTE FUNCTION sync_appointment_reminder_on_service_change()
  `);
  await knex.raw('DROP TRIGGER IF EXISTS appointment_reminders_legacy_suppression ON appointment_reminders');
  await knex.raw(`
    CREATE TRIGGER appointment_reminders_legacy_suppression
    BEFORE INSERT ON appointment_reminders
    FOR EACH ROW EXECUTE FUNCTION mark_legacy_suppressed_reminder_insert()
  `);

  // 3. One-time drift heal: future active appointments whose reminder clock
  // disagrees with the live row (12 rows in prod at time of writing). Healed
  // rows land armed and unmarked; the passes below restore the invariant.
  await knex.raw(`
    UPDATE appointment_reminders ar
       SET appointment_time = sync.correct_time,
           suppressed_by_sibling = false,
           -- Past-or-due times close the window (an armed flag on a past
           -- appointment keeps the row in every cron scan forever).
           reminder_72h_sent = (sync.correct_time <= NOW() + INTERVAL '72 hours 15 minutes'),
           reminder_72h_sent_at = CASE
             WHEN sync.correct_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
             ELSE NULL END,
           reminder_24h_sent = (sync.correct_time <= NOW()),
           reminder_24h_sent_at = CASE WHEN sync.correct_time <= NOW() THEN NOW() ELSE NULL END,
           updated_at = NOW()
      FROM (
        SELECT ss.id AS service_id,
               ((ss.scheduled_date + COALESCE(ss.window_start, TIME '08:00'))::timestamp
                AT TIME ZONE 'America/New_York') AS correct_time
          FROM scheduled_services ss
         WHERE ss.status IN ${MOVABLE_SERVICE}
           AND ss.scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
      ) sync
     WHERE sync.service_id = ar.scheduled_service_id
       AND ar.cancelled = false
       AND ar.appointment_time IS DISTINCT FROM sync.correct_time
  `);

  // 4. Re-assert one-owner-per-slot for future slots (separate statement —
  // a data-modifying CTE's sibling statements read the pre-update snapshot).
  // Keep = earliest created; losers are suppressed AND marked.
  await knex.raw(`
    UPDATE appointment_reminders dup
       SET suppressed_by_sibling = true,
           reminder_72h_sent = true,
           reminder_72h_sent_at = COALESCE(dup.reminder_72h_sent_at, NOW()),
           reminder_24h_sent = true,
           reminder_24h_sent_at = COALESCE(dup.reminder_24h_sent_at, NOW()),
           updated_at = NOW()
      FROM scheduled_services ssd
     WHERE ssd.id = dup.scheduled_service_id
       AND dup.cancelled = false
       AND dup.suppressed_by_sibling = false
       AND NOT (dup.reminder_72h_sent AND dup.reminder_24h_sent)
       AND ssd.status IN ${SENDABLE_SERVICE}
       AND ssd.scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
       AND EXISTS (
             SELECT 1
               FROM appointment_reminders keep
               JOIN scheduled_services ssk ON ssk.id = keep.scheduled_service_id
              WHERE keep.customer_id = dup.customer_id
                AND keep.id <> dup.id
                AND keep.cancelled = false
                AND keep.suppressed_by_sibling = false
                AND ssk.status IN ${SENDABLE_SERVICE}
                AND ssk.scheduled_date = ssd.scheduled_date
                AND COALESCE(ssk.window_start, TIME '08:00') = COALESCE(ssd.window_start, TIME '08:00')
                AND (keep.created_at < dup.created_at
                     OR (keep.created_at = dup.created_at AND keep.id < dup.id)))
  `);

  // 5. Promote orphaned suppressed siblings: a drifted sender healed away in
  // pass 3 (or any historical departure) can leave a suppressed row as the
  // only remaining reminder for its slot. Promote the earliest suppressed
  // candidate per slot when no owner remains.
  await knex.raw(`
    UPDATE appointment_reminders p
       SET suppressed_by_sibling = false,
           reminder_72h_sent = (p.appointment_time <= NOW() + INTERVAL '72 hours 15 minutes'),
           reminder_72h_sent_at = CASE
             WHEN p.appointment_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW()
             ELSE NULL END,
           reminder_24h_sent = (p.appointment_time <= NOW()),
           reminder_24h_sent_at = CASE WHEN p.appointment_time <= NOW() THEN NOW() ELSE NULL END,
           updated_at = NOW()
      FROM scheduled_services ssp
     WHERE ssp.id = p.scheduled_service_id
       AND p.cancelled = false
       AND p.suppressed_by_sibling = true
       AND ssp.status IN ${SENDABLE_SERVICE}
       AND ssp.scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
       AND p.appointment_time = ((ssp.scheduled_date + COALESCE(ssp.window_start, TIME '08:00'))::timestamp
                                 AT TIME ZONE 'America/New_York')
       AND NOT EXISTS (
             SELECT 1
               FROM appointment_reminders own
               JOIN scheduled_services sso ON sso.id = own.scheduled_service_id
              WHERE own.customer_id = p.customer_id
                AND own.appointment_time = p.appointment_time
                AND own.cancelled = false
                AND own.suppressed_by_sibling = false
                AND sso.status IN ${SENDABLE_SERVICE})
       AND p.id = (
             SELECT p2.id
               FROM appointment_reminders p2
               JOIN scheduled_services ss2 ON ss2.id = p2.scheduled_service_id
              WHERE p2.customer_id = p.customer_id
                AND p2.appointment_time = p.appointment_time
                AND p2.cancelled = false
                AND p2.suppressed_by_sibling = true
                AND ss2.status IN ${SENDABLE_SERVICE}
              ORDER BY p2.created_at ASC, p2.id ASC
              LIMIT 1)
  `);
};

exports.down = async function down(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  if (hasServices) {
    await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_sync_reminder ON scheduled_services');
  }
  const hasRemindersTable = await knex.schema.hasTable('appointment_reminders');
  if (hasRemindersTable) {
    await knex.raw('DROP TRIGGER IF EXISTS appointment_reminders_legacy_suppression ON appointment_reminders');
  }
  await knex.raw('DROP FUNCTION IF EXISTS mark_legacy_suppressed_reminder_insert()');
  await knex.raw('DROP FUNCTION IF EXISTS sync_appointment_reminder_on_service_change()');
  await knex.raw('DROP FUNCTION IF EXISTS promote_suppressed_reminder_sibling(uuid, uuid, timestamptz, date, time)');
  await knex.raw('DROP FUNCTION IF EXISTS reminder_slot_lock_key(uuid, timestamptz)');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  if (hasReminders) {
    const hasCol = await knex.schema.hasColumn('appointment_reminders', 'suppressed_by_sibling');
    if (hasCol) {
      await knex.schema.alterTable('appointment_reminders', (t) => {
        t.dropColumn('suppressed_by_sibling');
      });
    }
  }
};
