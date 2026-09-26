/**
 * Termite annual plan — slice 5, Codex #4921 r4 P1.
 *
 * When both the SMS and the email leg of a termite 45- or 30-day renewal
 * notice keep failing, the daily retry kept trying silently and staff heard
 * nothing until the term reached term_end (notice_missed_escalated_at). This
 * adds the per-rung confirmed-bell witnesses for the earlier escalation: a
 * rung still UNDELIVERED once its own deadline has passed (today >
 * term_end - 45 for the 45-day rung, today > term_end - 30 for the 30-day
 * rung) rings one staff bell, stamped only after notifyAdmin confirms the
 * insert so a failed bell is retried on the next sweep.
 *
 * Separate from notice_{45,30}_late_escalated_at on purpose: those mean the
 * notice DID go out, late; these mean it has NOT gone out and its on-time
 * window is gone. A rung can get both, in that order.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table. checkAndSend gates
 * the undelivered sweep on both columns existing, so the rest of the
 * termite pass keeps running on a database that has not run this yet.
 */

const COLUMNS = ['notice_45_undelivered_escalated_at', 'notice_30_undelivered_escalated_at'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const col of COLUMNS) {
    if (await knex.schema.hasColumn('annual_prepay_terms', col)) continue;
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.timestamp(col, { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const col of COLUMNS) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', col))) continue;
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn(col);
    });
  }
};
