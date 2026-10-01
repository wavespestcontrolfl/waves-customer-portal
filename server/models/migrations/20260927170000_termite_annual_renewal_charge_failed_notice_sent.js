/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 / 050001 / 050002,
 * 20260927020000, 20260927040000, 20260927050000 and 20260927160000, all
 * PUSHED and frozen (PR #4971) — this column is new; nothing in those files
 * is edited.
 *
 * annual_prepay_terms.renewal_charge_failed_notice_sent_at — Codex #4971 r15
 * P2: sendCustomerMessage can return a non-throwing { blocked: true,
 * deferred: true } during quiet hours (or the pay-link clearance itself can
 * defer on a dispute-suspended successor). followThroughChargeOutcome used
 * to ignore that result — `done` was computed from the staff bell and the
 * pay-link delivery alone, so the row was stamped
 * renewal_charge_failure_handled_at and dropped out of leg 7c's
 * (reconcileChargeFollowThrough) candidate scan even though the customer's
 * "your renewal payment didn't go through" text was never actually sent.
 * This column is the notice's own durable delivery stamp (the same shape as
 * chokepoint A's invoice delivery stamps) — followThroughChargeOutcome now
 * retries the notice on every tick until this is set, and only then folds
 * it into `done`, so a quiet-hours (or dispute) deferral is retried exactly
 * once it clears rather than dropped for good.
 *
 * Additive and nullable.
 */
const COLUMN = 'renewal_charge_failed_notice_sent_at';

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
