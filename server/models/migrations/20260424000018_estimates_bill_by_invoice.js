/**
 * estimates.bill_by_invoice — per-estimate opt-in for "invoice mode" on
 * accept. When true, the customer-facing accept flow skips the normal
 * onboarding + payment-collection path and instead auto-generates an
 * invoice (due immediately) based on their pick:
 *
 *   - Recurring: still creates the recurring schedule (via
 *     EstimateConverter), but invoices only the first quarter (monthly
 *     total × 3). No $99 setup-fee invoice — we're billing the first
 *     visit outright.
 *   - One-time:  books the visit and invoices the one-time total.
 *
 * Email + SMS both go out with the pay link. Customer sees an
 * "invoice on the way" confirmation instead of the onboarding CTA.
 *
 * Intended use: existing customers who've already had service and are
 * moving onto a recurring plan, where collecting a payment method up
 * front is overkill — just invoice them for the first visit.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.boolean('bill_by_invoice').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('bill_by_invoice');
  });
};
