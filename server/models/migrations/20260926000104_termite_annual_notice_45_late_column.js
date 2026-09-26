/**
 * Termite annual plan — slice 5 follow-up (Codex #4921 r1 P1).
 *
 * annual_prepay_terms.notice_45_late_sent_at — records a 45-day-rung notice
 * that went out LATE (fewer than 45 days before term_end, via the catch-up
 * window after a missed daily run). The signed v3 agreement promises the
 * first written renewal notice "at least 45 days" before the renewal date,
 * so a late send must never stamp notice_45_sent_at — that column is the
 * contractual witness the renewal charge requires. The late send still
 * informs the customer; this column stops the catch-up from re-sending it
 * daily and lets the renewal job see that the 45-day promise was missed.
 *
 * Additive, nullable, hasTable/hasColumn-guarded.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_late_sent_at')) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.timestamp('notice_45_late_sent_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_late_sent_at'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.dropColumn('notice_45_late_sent_at');
  });
};
