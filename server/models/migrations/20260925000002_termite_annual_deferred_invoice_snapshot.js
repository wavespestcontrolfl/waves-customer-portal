/**
 * Termite annual plan — deferred-invoice snapshot (slice 3a fix, codex P1
 * review of 20260925000001, pushed/frozen — see that file's own header;
 * this is a NEW additive migration, never an edit to it).
 *
 * estimates.annual_plan_deferred_invoice — the EXACT invoice the accept-time
 * converter's prepay_annual branch would have billed for a sign-before-pay
 * termite annual-plan accept (amount, setup fee, line items, title, notes,
 * tax rate, monthly rate), computed with the SAME resolvers that branch
 * uses today (resolveAnnualPrepayInvoiceAmount / the WaveGuard discount /
 * frozenRodentBaitSetupAmount / the commercial tax blend), snapshotted the
 * moment the accept transaction decides to defer.
 *
 * Why a snapshot instead of re-deriving at signature time: activation can
 * run days or weeks after acceptance, by which point pricing config,
 * WaveGuard tier discounts, or tax rates may have changed — re-running the
 * resolvers then could bill a different amount than the customer actually
 * accepted. Billing exactly this snapshot (server/services/
 * termite-annual-activation.js) makes activation a pure "charge what was
 * promised" step, never a second pricing decision.
 *
 * Nullable jsonb, no default: only ever set on a termite-annual-plan accept
 * that deferred (estimates.annual_plan_activation_status ===
 * 'awaiting_signature'); every other estimate leaves it null forever.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the estimates table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (!(await knex.schema.hasColumn('estimates', 'annual_plan_deferred_invoice'))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.jsonb('annual_plan_deferred_invoice');
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (await knex.schema.hasColumn('estimates', 'annual_plan_deferred_invoice')) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn('annual_plan_deferred_invoice');
      });
    }
  }
};
