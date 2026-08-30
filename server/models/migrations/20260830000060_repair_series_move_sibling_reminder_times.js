/**
 * Repair reminders re-armed at the 08:00 ET fallback (series-move incident,
 * 2026-08-29/30 — two occurrences): collective series moves passed sibling
 * window starts as pg raw 'HH:MM:SS', normalizeHHMM rejected them, and
 * rescheduleReminderTime fell back to 08:00 — so 72h/24h texts for those
 * visits would fire ~hours early and quote the wrong window. The code fix
 * lands with this migration; this repairs the rows already written.
 *
 * Scope: FUTURE (Eastern calendar), non-terminal, windowed visits whose
 * active reminder sits exactly at that date's 08:00 ET while the visit
 * window says otherwise. Idempotent; pre-closed placeholder rows excluded
 * (their 08:00 is deliberate). timestamptz derivation: naive (date + time)
 * interpreted as America/New_York — the ET-safe direction.
 *
 * Suppressed-by-sibling rows DO get the time repair — handleReschedule
 * stamps appointment_time on them too (only the flag re-arms are gated on
 * suppression), and sibling promotion matches on appointment_time, so a
 * suppressed row left at 08:00 would detach from its slot owner. Their
 * deliberate placeholder sent flags are preserved: suppressed rows are
 * excluded from the re-arm passes only.
 *
 * Second pass: the erroneous 08:00 time may have sat inside the 72h/24h
 * cutoff when the move re-armed the row, stamping a SYNTHETIC coverage flag
 * with no text ever sent — repairing only the time would then silence the
 * reminder forever. For repaired rows whose corrected time is still beyond
 * the cutoff — the canonical 72.25h/24.25h boundaries from
 * reminderFlagsCoveredByNotice, so a reminder legitimately covered by a
 * notice inside the cron's 15-minute slack band is never re-armed —
 * re-arm the flag unless THAT reminder was genuinely delivered:
 * per-purpose, per-appointment, and scoped to the current reschedule
 * generation (evidence at/after the flag's own stamp, minus clock slack —
 * a delivery for the visit's OLD slot must not silence the repaired one).
 * SMS deliveries live in messaging_audit_log (appointment_reminder_72h vs
 * _24h, sent, real provider id); reminder EMAILS audit into
 * customer_interactions (template_key appointment.reminder_72h / _24h,
 * status sent) — both are checked. No legacy sms_log fallback — the bug
 * postdates audit-log linkage, so every genuine send for an affected row
 * has a linked audit row.
 */
exports.up = async function up(knex) {
  const repaired = await knex.raw(`
    UPDATE appointment_reminders ar
    SET appointment_time = (ss.scheduled_date + ss.window_start) AT TIME ZONE 'America/New_York',
        updated_at = now()
    FROM scheduled_services ss
    WHERE ss.id = ar.scheduled_service_id
      AND ar.cancelled = false
      AND COALESCE(ar.windows_preclosed, false) = false
      AND ss.window_start IS NOT NULL
      AND ss.window_start <> time '08:00'
      AND ss.status NOT IN ('completed', 'cancelled', 'skipped', 'no_show')
      AND ss.scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
      AND ar.appointment_time = (ss.scheduled_date + time '08:00') AT TIME ZONE 'America/New_York'
    RETURNING ar.id, ar.suppressed_by_sibling
  `);
  const rows = repaired.rows || [];
  console.log(`[migration] repaired ${rows.length} reminder row(s) mis-armed at the 08:00 fallback`);
  const ids = rows.filter((r) => !r.suppressed_by_sibling).map((r) => r.id);
  if (!ids.length) return;

  const rearm = async (flag, flagAt, cutoff, purpose, templateKey) => {
    const res = await knex.raw(
      `
      UPDATE appointment_reminders ar
      SET ${flag} = false, ${flagAt} = NULL, updated_at = now()
      WHERE ar.id = ANY(?)
        AND ar.${flag} = true
        AND COALESCE(ar.suppressed_by_sibling, false) = false
        AND ar.appointment_time > NOW() + interval '${cutoff}'
        AND NOT EXISTS (
          SELECT 1 FROM messaging_audit_log mal
          WHERE mal.appointment_id = ar.scheduled_service_id::text
            AND mal.purpose = ?
            AND mal.sent_at IS NOT NULL
            AND mal.sent_at >= ar.${flagAt} - interval '5 minutes'
            AND (mal.provider_message_id ~ '^(SM|MM)' OR mal.channel = 'email')
        )
        AND NOT EXISTS (
          SELECT 1 FROM customer_interactions ci
          WHERE ci.interaction_type = 'email_outbound'
            AND ci.metadata->>'scheduled_service_id' = ar.scheduled_service_id::text
            AND ci.metadata->>'template_key' = ?
            AND ci.metadata->>'status' = 'sent'
            AND ci.created_at >= ar.${flagAt} - interval '5 minutes'
        )
    `,
      [ids, purpose, templateKey]
    );
    console.log(`[migration] re-armed ${res.rowCount ?? 0} synthetic ${flag} flag(s)`);
  };
  await rearm('reminder_72h_sent', 'reminder_72h_sent_at', '72 hours 15 minutes', 'appointment_reminder_72h', 'appointment.reminder_72h');
  await rearm('reminder_24h_sent', 'reminder_24h_sent_at', '24 hours 15 minutes', 'appointment_reminder_24h', 'appointment.reminder_24h');
};

exports.down = async function down() {
  // Data repair — the mis-armed times are not worth restoring.
};
