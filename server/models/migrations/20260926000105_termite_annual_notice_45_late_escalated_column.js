/**
 * Termite annual plan — slice 5 follow-up (Codex #4921 r2 P1).
 *
 * annual_prepay_terms.notice_45_late_escalated_at — records that the admin
 * bell for a LATE 45-day notice (notice_45_late_sent_at) actually landed.
 * fileTermiteLateNoticeException calls NotificationService.notifyAdmin,
 * which returns null on an insert failure rather than throwing — and
 * notice_45_late_sent_at already blocks the SEND from ever being retried,
 * so without a separate witness for the BELL, a failed insert would lose
 * the escalation for good with no way to notice, let alone retry, it.
 * Stamped only on a confirmed notifyAdmin result; left null otherwise so
 * termiteLateNoticeEscalationCandidates() retries it on the next daily
 * sweep.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_late_escalated_at')) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.timestamp('notice_45_late_escalated_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_late_escalated_at'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.dropColumn('notice_45_late_escalated_at');
  });
};
