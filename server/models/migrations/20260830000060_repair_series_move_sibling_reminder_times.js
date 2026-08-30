/**
 * Repair reminders re-armed at the 08:00 ET fallback (series-move incident,
 * 2026-08-29/30 — two occurrences): collective series moves passed sibling
 * window starts as pg raw 'HH:MM:SS', normalizeHHMM rejected them, and
 * rescheduleReminderTime fell back to 08:00 — so 72h/24h texts for those
 * visits would fire ~hours early and quote the wrong window. The code fix
 * lands with this migration; this repairs the rows already written.
 *
 * Scope: FUTURE, non-terminal, windowed visits whose active reminder sits
 * exactly at that date's 08:00 ET while the visit window says otherwise.
 * Idempotent; sent flags untouched (a text already sent cannot be unsent);
 * pre-closed placeholder rows excluded (their 08:00 is deliberate).
 * timestamptz derivation: naive (date + time) interpreted as
 * America/New_York — the ET-safe direction.
 */
exports.up = async function up(knex) {
  const res = await knex.raw(`
    UPDATE appointment_reminders ar
    SET appointment_time = (ss.scheduled_date::timestamp + ss.window_start) AT TIME ZONE 'America/New_York',
        updated_at = now()
    FROM scheduled_services ss
    WHERE ss.id = ar.scheduled_service_id
      AND ar.cancelled = false
      AND COALESCE(ar.windows_preclosed, false) = false
      AND ss.window_start IS NOT NULL
      AND ss.window_start <> time '08:00'
      AND ss.status NOT IN ('completed', 'cancelled', 'skipped', 'no_show')
      AND ss.scheduled_date >= CURRENT_DATE
      AND ar.appointment_time = (ss.scheduled_date::timestamp + time '08:00') AT TIME ZONE 'America/New_York'
  `);
   
  console.log(`[migration] repaired ${res.rowCount ?? 0} reminder row(s) mis-armed at the 08:00 fallback`);
};

exports.down = async function down() {
  // Data repair — the mis-armed times are not worth restoring.
};
