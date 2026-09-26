/**
 * Termite annual plan — activation attempt throttle (slice 3a restructure,
 * codex P2 review round 2 of #4819). 20260925000001/2/3 are frozen (pushed;
 * the preview DB has already run them) and are never edited — this is a
 * NEW additive migration.
 *
 * estimates.annual_plan_activation_attempted_at — stamped by
 * termite-annual-activation.js's activateTermiteAnnualPlanForSignedContract
 * every time it ATTEMPTS to activate a signed termite-annual agreement
 * (success or failure), immediately before calling the converter. The
 * reconciliation sweep's activation scan orders by this column (oldest/
 * never-attempted first) and skips any row already attempted today (ET
 * calendar day) — without this, a permanently-failing activation (e.g. a
 * structurally broken accept-context snapshot) would retain a NULL
 * attempt stamp forever and monopolize every batch ahead of genuinely
 * retryable rows, exactly like the sibling invoices.annual_delivery_
 * attempted_at throttle from 20260925000003 solves for delivery.
 *
 * Nullable timestamptz, no default: only ever set on a termite-annual-plan
 * estimate once its first activation attempt runs; every other estimate in
 * the table leaves it null forever, and this column is read only by that
 * one reconciliation query.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the estimates table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (!(await knex.schema.hasColumn('estimates', 'annual_plan_activation_attempted_at'))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.timestamp('annual_plan_activation_attempted_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (await knex.schema.hasColumn('estimates', 'annual_plan_activation_attempted_at')) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn('annual_plan_activation_attempted_at');
      });
    }
  }
};
