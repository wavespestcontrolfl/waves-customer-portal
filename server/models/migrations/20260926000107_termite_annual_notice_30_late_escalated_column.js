/**
 * Termite annual plan — slice 5, pre-push audit P1 on the #4921 r3
 * structural fix (000106).
 *
 * 000106 added notice_30_late_sent_at and notice_missed_escalated_at, but
 * never added notice_30_late_escalated_at — the confirmed-bell witness for
 * a LATE 30-day rung, mirroring notice_45_late_escalated_at (000105).
 * termiteLateNoticeEscalationCandidates() queries this column
 * unconditionally (whereNotNull(notice_30_late_sent_at)
 * .whereNull(notice_30_late_escalated_at)), so on any database that ran
 * only through 000106 that query throws "column does not exist" — and
 * uncaught, that exception aborted checkAndSend entirely, including the
 * unrelated generic 30/15/7 loop. This migration adds the missing column;
 * checkAndSend also now gates the whole termite pass on every column it
 * queries (not just the ones the main candidate query touches) and runs
 * that pass under its own try/catch so a mid-rollout or truly unexpected
 * failure there can never take down the shared loop.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_30_late_escalated_at')) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.timestamp('notice_30_late_escalated_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_30_late_escalated_at'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.dropColumn('notice_30_late_escalated_at');
  });
};
