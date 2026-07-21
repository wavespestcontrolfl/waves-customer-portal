/**
 * Windowless pre-closed reminder placeholders (`windows_preclosed`).
 *
 * registerAppointment({ closeReminderWindows: true }) registers an untimed
 * visit at the canonical date+08:00 slot with both reminder windows
 * pre-closed, so the cron never texts "at 8:00 AM" for a time nobody chose.
 * But at the DB level such a row looked exactly like a deliverable slot
 * OWNER (#2808's one-owner-per-slot machinery): a REAL 8 AM visit
 * registered later would dedup against the placeholder and land fully
 * suppressed behind a row that never sends — the customer got no reminders
 * for the real timed visit — and on slot departure the promotion pass could
 * re-arm the placeholder into an 08:00 sender, resurrecting the very 8 AM
 * promise the pre-close exists to prevent.
 *
 * Fix, in two coordinated halves:
 *   - App side (appointment-reminders.js): the placeholder now inserts with
 *     suppressed_by_sibling = true (invisible to every ownership check —
 *     the registration dedups, the trigger's arrival check, and promotion's
 *     no-owner-remains check all require suppressed_by_sibling = false) AND
 *     the durable marker this migration adds, windows_preclosed = true.
 *   - DB side (this migration):
 *       1. promote_suppressed_reminder_sibling skips windows_preclosed
 *          candidates — a placeholder is never promoted into an armed
 *          08:00 sender when a real owner leaves the slot.
 *       2. sync_appointment_reminder_on_service_change holds placeholder
 *          semantics while the service stays windowless: a date-only move
 *          (or terminal→active bounce) keeps the row suppressed with both
 *          windows closed instead of re-arming it at the new date's 08:00.
 *          When a real window arrives (NEW.window_start IS NOT NULL) the
 *          marker clears and the row becomes an ordinary registration:
 *          ownership is re-decided at the new slot and the windows re-arm
 *          from the real start (the existing time_changed/suppressed
 *          re-arm branches, since the placeholder was suppressed).
 *
 * Invariant: windows_preclosed = true implies suppressed_by_sibling = true
 * (both are set together at insert; the only writer that clears the marker
 * — the sync trigger's real-window branch — re-decides suppression in the
 * same UPDATE). No backfill is needed: closeReminderWindows ships in the
 * same PR as this migration, so no pre-existing rows carry pre-closed
 * windows from that path.
 *
 * The function bodies below are the #2808 texts
 * (20260716150000_sync_reminders_on_service_change.js) with only the
 * changes described above; down() restores the #2808 bodies verbatim
 * BEFORE dropping the column (the new bodies reference it).
 */

// Status sets — MUST stay in lockstep with
// 20260716150000_sync_reminders_on_service_change.js.
const MOVABLE_SERVICE = `('pending','confirmed','rescheduled','en_route','on_site')`;
const SENDABLE_SERVICE = `('pending','confirmed','en_route','on_site')`;
const TERMINAL_SERVICE = `('cancelled','skipped','no_show','completed')`;

const PROMOTE_SQL = `
CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling(
  p_customer_id uuid, p_departing_service_id uuid, p_slot_time timestamptz,
  p_slot_date date, p_slot_window time,
  p_owner_72h_sent boolean DEFAULT false, p_owner_72h_sent_at timestamptz DEFAULT NULL,
  p_owner_24h_sent boolean DEFAULT false, p_owner_24h_sent_at timestamptz DEFAULT NULL
) RETURNS void AS $$
BEGIN
  -- Promote ONE suppressed sibling whose service still occupies the slot,
  -- but only when no active owner remains there. Only rows explicitly
  -- marked suppressed_by_sibling are candidates — a sender that genuinely
  -- delivered its reminders is never re-armed.
  UPDATE appointment_reminders arp
     SET suppressed_by_sibling = false,
         -- Carry forward the departing owner's window state: its reminders
         -- were rendered with the merged slot label, so a window it already
         -- delivered (or covered) is delivered for the sibling too —
         -- re-arming it would duplicate the text. An otherwise-unsent 72h
         -- window stays ARMED while still reachable — the cron delivers it
         -- in the (24.25h, 72.25h] band — and is closed only below 24.25
         -- hours, where an armed flag could never fire and would just keep
         -- the row in every cron scan forever. Same rule for the 24h window
         -- at its own boundary (appointment already past).
         reminder_72h_sent = p_owner_72h_sent
                             OR (arp.appointment_time <= NOW() + INTERVAL '24 hours 15 minutes'),
         reminder_72h_sent_at = CASE
           WHEN p_owner_72h_sent THEN COALESCE(p_owner_72h_sent_at, NOW())
           WHEN arp.appointment_time <= NOW() + INTERVAL '24 hours 15 minutes' THEN NOW()
           ELSE NULL END,
         reminder_24h_sent = p_owner_24h_sent OR (arp.appointment_time <= NOW()),
         reminder_24h_sent_at = CASE
           WHEN p_owner_24h_sent THEN COALESCE(p_owner_24h_sent_at, NOW())
           WHEN arp.appointment_time <= NOW() THEN NOW()
           ELSE NULL END,
         updated_at = NOW()
   WHERE arp.id = (
           SELECT ar2.id
             FROM appointment_reminders ar2
             JOIN scheduled_services ss2 ON ss2.id = ar2.scheduled_service_id
            WHERE ar2.customer_id = p_customer_id
              AND ar2.appointment_time = p_slot_time
              AND ar2.cancelled = false
              AND ar2.suppressed_by_sibling = true
              -- Windowless pre-closed placeholders are NOT promotion
              -- candidates: promoting one would arm an 08:00 sender for a
              -- time nobody chose — the exact promise closeReminderWindows
              -- exists to prevent. (Ordinary windowless suppressed siblings,
              -- e.g. self-heal registrations that lost the slot, keep their
              -- legacy promotability.)
              AND ar2.windows_preclosed = false
              AND ar2.scheduled_service_id <> p_departing_service_id
              AND ss2.status IN ${SENDABLE_SERVICE}
              AND ss2.scheduled_date = p_slot_date
              AND COALESCE(ss2.window_start, TIME '08:00') = COALESCE(p_slot_window, TIME '08:00')
            ORDER BY ar2.created_at ASC, ar2.id ASC
            LIMIT 1)
     AND NOT EXISTS (
           SELECT 1
             FROM appointment_reminders ar3
             LEFT JOIN scheduled_services ss3 ON ss3.id = ar3.scheduled_service_id
            WHERE ar3.customer_id = p_customer_id
              AND ar3.appointment_time = p_slot_time
              AND ar3.cancelled = false
              AND ar3.suppressed_by_sibling = false
              AND (ar3.scheduled_service_id IS NULL
                   OR (ar3.scheduled_service_id <> p_departing_service_id
                       AND ss3.status IN ${SENDABLE_SERVICE})));
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
  dep_72h boolean;
  dep_72h_at timestamptz;
  dep_24h boolean;
  dep_24h_at timestamptz;
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

  -- Capture the departing row's window state BEFORE any update rewrites it:
  -- when this row was the slot owner, its reminders were rendered with the
  -- merged slot label, so a promoted sibling must inherit what was already
  -- delivered rather than re-arming it.
  SELECT ar0.reminder_72h_sent, ar0.reminder_72h_sent_at,
         ar0.reminder_24h_sent, ar0.reminder_24h_sent_at
    INTO dep_72h, dep_72h_at, dep_24h, dep_24h_at
    FROM appointment_reminders ar0
   WHERE ar0.scheduled_service_id = NEW.id
     AND ar0.cancelled = false
     AND ar0.suppressed_by_sibling = false;
  dep_72h := COALESCE(dep_72h, false);
  dep_24h := COALESCE(dep_24h, false);

  IF became_terminal THEN
    -- Serialize with registration on the vacated slot BEFORE touching any
    -- reminder row: registration takes the advisory lock first and then
    -- updates the owner's merged label, so locking a reminder row here and
    -- only then requesting the advisory lock would invert that order and
    -- deadlock. It also ensures the promotion below sees any suppressed
    -- sibling a concurrent registration is inserting.
    PERFORM pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time));
    UPDATE appointment_reminders
       SET cancelled = true, updated_at = NOW()
     WHERE scheduled_service_id = NEW.id AND cancelled = false;
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start,
                                                dep_72h, dep_72h_at, dep_24h, dep_24h_at);
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
    -- Only a non-suppressed row the cron will deliver for counts: either a
    -- row whose live service is sendable, or an unlinked legacy row (NULL
    -- scheduled_service_id — the cron skips its live-status guard for
    -- those, so they send). 'rescheduled' pending-rebook markers and
    -- terminal rows are skipped by the cron and must not swallow the
    -- incoming row's reminders. (Windowless pre-closed placeholders insert
    -- with suppressed_by_sibling = true, so they are already excluded.)
    owner_exists := EXISTS (
      SELECT 1
        FROM appointment_reminders ar2
        LEFT JOIN scheduled_services ss2 ON ss2.id = ar2.scheduled_service_id
       WHERE ar2.customer_id = NEW.customer_id
         AND ar2.appointment_time = new_appt_time
         AND ar2.cancelled = false
         AND ar2.suppressed_by_sibling = false
         AND (ar2.scheduled_service_id IS NULL
              OR (ar2.scheduled_service_id <> NEW.id
                  AND ss2.status IN ${SENDABLE_SERVICE})));

    -- Window flags:
    --   windowless pre-closed placeholder (windows_preclosed = true) AND
    --   the service is STILL windowless -> hold placeholder semantics:
    --                              stay suppressed, keep both windows
    --                              closed, keep the marker. A date-only
    --                              move (or a terminal->active bounce) of
    --                              an untimed visit must not re-arm an
    --                              08:00 sender nor claim slot ownership.
    --                              The moment a real window arrives
    --                              (NEW.window_start IS NOT NULL) the
    --                              marker clears and the branches below
    --                              treat the row like any arrival: owner
    --                              check, then re-arm from the real start
    --                              (the row was suppressed, so the
    --                              time_changed-or-suppressed re-arm
    --                              applies).
    --   owner_exists            -> fully suppressed under the slot owner.
    --   time_changed            -> re-arm for the new time (old sent state
    --                              was for a different time); past-or-due
    --                              times close the window instead (an armed
    --                              flag on a past appointment keeps the row
    --                              in every cron scan forever).
    --   same-time reactivation  -> a previously suppressed row is re-decided
    --                              like an arrival; a previous owner KEEPS
    --                              its sent flags — a customer who already
    --                              got the day-before text for this exact
    --                              slot must not get it again just because
    --                              the visit bounced through 'rescheduled'
    --                              or a terminal status and back.
    UPDATE appointment_reminders
       SET appointment_time = new_appt_time,
           cancelled = false,
           suppressed_by_sibling = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL THEN true
             ELSE owner_exists END,
           windows_preclosed = (windows_preclosed AND NEW.window_start IS NULL),
           -- A row landing suppressed under an owner must also claim any
           -- still-pending confirmation: the deferred/recovery confirmation
           -- senders check only cancelled/confirmation_sent, and the slot's
           -- owner already speaks for this visit. A held placeholder keeps
           -- its registration-time confirmation handling untouched (no
           -- owner speaks for it — it was never merged into one).
           confirmation_sent = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL THEN confirmation_sent
             WHEN owner_exists THEN true
             ELSE confirmation_sent END,
           confirmation_sent_at = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL THEN confirmation_sent_at
             WHEN owner_exists THEN COALESCE(confirmation_sent_at, NOW())
             ELSE confirmation_sent_at END,
           reminder_72h_sent = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL THEN true
             WHEN owner_exists THEN true
             WHEN time_changed OR suppressed_by_sibling
               THEN new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes'
             ELSE reminder_72h_sent END,
           reminder_72h_sent_at = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL
               THEN COALESCE(reminder_72h_sent_at, NOW())
             WHEN owner_exists THEN NOW()
             WHEN time_changed OR suppressed_by_sibling THEN
               CASE WHEN new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW() ELSE NULL END
             ELSE reminder_72h_sent_at END,
           reminder_24h_sent = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL THEN true
             WHEN owner_exists THEN true
             WHEN time_changed OR suppressed_by_sibling THEN new_appt_time <= NOW()
             ELSE reminder_24h_sent END,
           reminder_24h_sent_at = CASE
             WHEN windows_preclosed AND NEW.window_start IS NULL
               THEN COALESCE(reminder_24h_sent_at, NOW())
             WHEN owner_exists THEN NOW()
             WHEN time_changed OR suppressed_by_sibling THEN
               CASE WHEN new_appt_time <= NOW() THEN NOW() ELSE NULL END
             ELSE reminder_24h_sent_at END,
           updated_at = NOW()
     WHERE scheduled_service_id = NEW.id;

    IF time_changed THEN
      PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                  OLD.scheduled_date, OLD.window_start,
                                                  dep_72h, dep_72h_at, dep_24h, dep_24h_at);
    END IF;
  END IF;

  -- Owner entered 'rescheduled' in place (no move): its slot departure was
  -- not handled above, so promote a suppressed sibling there. When the move
  -- and the status change happen together, the time_changed branch already
  -- promoted at the old slot.
  IF entered_rescheduled AND NOT time_changed THEN
    PERFORM pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time));
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start,
                                                dep_72h, dep_72h_at, dep_24h, dep_24h_at);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

// ── #2808 bodies, verbatim (20260716150000_sync_reminders_on_service_change.js)
// — restored by down() so a rollback leaves the pre-marker machinery intact
// before the column drops out from under the new bodies. ──

const PRIOR_PROMOTE_SQL = `
CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling(
  p_customer_id uuid, p_departing_service_id uuid, p_slot_time timestamptz,
  p_slot_date date, p_slot_window time,
  p_owner_72h_sent boolean DEFAULT false, p_owner_72h_sent_at timestamptz DEFAULT NULL,
  p_owner_24h_sent boolean DEFAULT false, p_owner_24h_sent_at timestamptz DEFAULT NULL
) RETURNS void AS $$
BEGIN
  UPDATE appointment_reminders arp
     SET suppressed_by_sibling = false,
         reminder_72h_sent = p_owner_72h_sent
                             OR (arp.appointment_time <= NOW() + INTERVAL '24 hours 15 minutes'),
         reminder_72h_sent_at = CASE
           WHEN p_owner_72h_sent THEN COALESCE(p_owner_72h_sent_at, NOW())
           WHEN arp.appointment_time <= NOW() + INTERVAL '24 hours 15 minutes' THEN NOW()
           ELSE NULL END,
         reminder_24h_sent = p_owner_24h_sent OR (arp.appointment_time <= NOW()),
         reminder_24h_sent_at = CASE
           WHEN p_owner_24h_sent THEN COALESCE(p_owner_24h_sent_at, NOW())
           WHEN arp.appointment_time <= NOW() THEN NOW()
           ELSE NULL END,
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
             LEFT JOIN scheduled_services ss3 ON ss3.id = ar3.scheduled_service_id
            WHERE ar3.customer_id = p_customer_id
              AND ar3.appointment_time = p_slot_time
              AND ar3.cancelled = false
              AND ar3.suppressed_by_sibling = false
              AND (ar3.scheduled_service_id IS NULL
                   OR (ar3.scheduled_service_id <> p_departing_service_id
                       AND ss3.status IN ${SENDABLE_SERVICE})));
END;
$$ LANGUAGE plpgsql;
`;

const PRIOR_FUNCTION_SQL = `
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
  dep_72h boolean;
  dep_72h_at timestamptz;
  dep_24h boolean;
  dep_24h_at timestamptz;
BEGIN
  became_terminal := NEW.status IN ${TERMINAL_SERVICE}
                     AND OLD.status NOT IN ${TERMINAL_SERVICE};
  became_active   := OLD.status IN ${TERMINAL_SERVICE}
                     AND NEW.status IN ${MOVABLE_SERVICE};
  became_sendable := OLD.status = 'rescheduled'
                     AND NEW.status IN ${SENDABLE_SERVICE};
  entered_rescheduled := OLD.status IN ${SENDABLE_SERVICE}
                         AND NEW.status = 'rescheduled';
  time_changed    := (NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date)
                     OR (NEW.window_start IS DISTINCT FROM OLD.window_start);

  old_appt_time := ((OLD.scheduled_date + COALESCE(OLD.window_start, TIME '08:00'))::timestamp
                    AT TIME ZONE 'America/New_York');

  SELECT ar0.reminder_72h_sent, ar0.reminder_72h_sent_at,
         ar0.reminder_24h_sent, ar0.reminder_24h_sent_at
    INTO dep_72h, dep_72h_at, dep_24h, dep_24h_at
    FROM appointment_reminders ar0
   WHERE ar0.scheduled_service_id = NEW.id
     AND ar0.cancelled = false
     AND ar0.suppressed_by_sibling = false;
  dep_72h := COALESCE(dep_72h, false);
  dep_24h := COALESCE(dep_24h, false);

  IF became_terminal THEN
    PERFORM pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time));
    UPDATE appointment_reminders
       SET cancelled = true, updated_at = NOW()
     WHERE scheduled_service_id = NEW.id AND cancelled = false;
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start,
                                                dep_72h, dep_72h_at, dep_24h, dep_24h_at);
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ${MOVABLE_SERVICE} THEN
    RETURN NEW;
  END IF;

  IF time_changed OR became_active OR became_sendable THEN
    new_appt_time := ((NEW.scheduled_date + COALESCE(NEW.window_start, TIME '08:00'))::timestamp
                      AT TIME ZONE 'America/New_York');

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

    owner_exists := EXISTS (
      SELECT 1
        FROM appointment_reminders ar2
        LEFT JOIN scheduled_services ss2 ON ss2.id = ar2.scheduled_service_id
       WHERE ar2.customer_id = NEW.customer_id
         AND ar2.appointment_time = new_appt_time
         AND ar2.cancelled = false
         AND ar2.suppressed_by_sibling = false
         AND (ar2.scheduled_service_id IS NULL
              OR (ar2.scheduled_service_id <> NEW.id
                  AND ss2.status IN ${SENDABLE_SERVICE})));

    UPDATE appointment_reminders
       SET appointment_time = new_appt_time,
           cancelled = false,
           suppressed_by_sibling = owner_exists,
           confirmation_sent = CASE WHEN owner_exists THEN true ELSE confirmation_sent END,
           confirmation_sent_at = CASE
             WHEN owner_exists THEN COALESCE(confirmation_sent_at, NOW())
             ELSE confirmation_sent_at END,
           reminder_72h_sent = CASE
             WHEN owner_exists THEN true
             WHEN time_changed OR suppressed_by_sibling
               THEN new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes'
             ELSE reminder_72h_sent END,
           reminder_72h_sent_at = CASE
             WHEN owner_exists THEN NOW()
             WHEN time_changed OR suppressed_by_sibling THEN
               CASE WHEN new_appt_time <= NOW() + INTERVAL '72 hours 15 minutes' THEN NOW() ELSE NULL END
             ELSE reminder_72h_sent_at END,
           reminder_24h_sent = CASE
             WHEN owner_exists THEN true
             WHEN time_changed OR suppressed_by_sibling THEN new_appt_time <= NOW()
             ELSE reminder_24h_sent END,
           reminder_24h_sent_at = CASE
             WHEN owner_exists THEN NOW()
             WHEN time_changed OR suppressed_by_sibling THEN
               CASE WHEN new_appt_time <= NOW() THEN NOW() ELSE NULL END
             ELSE reminder_24h_sent_at END,
           updated_at = NOW()
     WHERE scheduled_service_id = NEW.id;

    IF time_changed THEN
      PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                  OLD.scheduled_date, OLD.window_start,
                                                  dep_72h, dep_72h_at, dep_24h, dep_24h_at);
    END IF;
  END IF;

  IF entered_rescheduled AND NOT time_changed THEN
    PERFORM pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time));
    PERFORM promote_suppressed_reminder_sibling(NEW.customer_id, NEW.id, old_appt_time,
                                                OLD.scheduled_date, OLD.window_start,
                                                dep_72h, dep_72h_at, dep_24h, dep_24h_at);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

exports.up = async function up(knex) {
  const hasServices = await knex.schema.hasTable('scheduled_services');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  if (!hasServices || !hasReminders) return;

  // 1. Durable placeholder marker.
  const hasCol = await knex.schema.hasColumn('appointment_reminders', 'windows_preclosed');
  if (!hasCol) {
    await knex.schema.alterTable('appointment_reminders', (t) => {
      t.boolean('windows_preclosed').notNullable().defaultTo(false);
    });
  }

  // 2. Marker-aware function bodies (same signatures — CREATE OR REPLACE).
  await knex.raw(PROMOTE_SQL);
  await knex.raw(FUNCTION_SQL);
};

exports.down = async function down(knex) {
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  if (!hasReminders) return;

  // Restore the #2808 bodies FIRST — the marker-aware versions reference the
  // column this down() is about to drop.
  const hasServices = await knex.schema.hasTable('scheduled_services');
  if (hasServices) {
    await knex.raw(PRIOR_PROMOTE_SQL);
    await knex.raw(PRIOR_FUNCTION_SQL);
  }

  const hasCol = await knex.schema.hasColumn('appointment_reminders', 'windows_preclosed');
  if (hasCol) {
    await knex.schema.alterTable('appointment_reminders', (t) => {
      t.dropColumn('windows_preclosed');
    });
  }
};
