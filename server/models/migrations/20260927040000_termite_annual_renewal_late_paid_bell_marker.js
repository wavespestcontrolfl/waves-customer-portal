/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 / 050001 / 050002 and
 * 20260927020000, all PUSHED and frozen (PR #4971) — this column is new;
 * nothing in those files is edited.
 *
 * annual_prepay_terms.renewal_late_paid_belled_at — Codex #4971 r4 P1: a
 * renewal payment can land AFTER the prior year stopped authorizing it (an
 * ACH debit that cleared behind a refund, void or other change to the
 * parent the decision gate cannot hold back). The paid renewal stays active
 * and staff get ONE alert to refund or honor it. The alert rings at the paid
 * sync; this column records that it persisted, so the daily sweep's backstop
 * scan (a lost alert) excludes the row once staff have been told instead of
 * re-selecting it every tick.
 *
 * The write-ahead charge outcome (the same review round) reuses the existing
 * renewal_charge_failure_kind column ('outcome_pending') — no column for it.
 *
 * Additive and nullable.
 */
const COLUMN = 'renewal_late_paid_belled_at';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', COLUMN))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.timestamp(COLUMN, { useTz: true }));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', COLUMN)) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.dropColumn(COLUMN));
  }
};
