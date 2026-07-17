/**
 * Billing lane goes explicit — extend customers.billing_mode to the full
 * lane set and classify the provably-monthly cohort.
 *
 * Owner directive 2026-07-17 (after the membership double-billing incident):
 * "one explicit 'how does this customer pay' setting per customer — set in
 * one place, and every flow reads that instead of inferring."
 *
 * 1. CHECK gains 'per_visit' and 'one_time' alongside the existing
 *    'monthly_membership' / 'per_application' / 'annual_prepay'.
 * 2. Backfill is EVIDENCE-BASED and minimal: only customers with an actual
 *    collected "WaveGuard Monthly" dues payment are stamped
 *    'monthly_membership' — provably in that lane. Everyone else stays NULL
 *    (legacy inference, behavior-preserving) for the owner to classify via
 *    the new profile control. Rows already carrying a mode are untouched.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;
  const hasMode = await knex.schema.hasColumn('customers', 'billing_mode');
  if (!hasMode) return;

  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_mode_check');
  await knex.raw(`
    ALTER TABLE customers
    ADD CONSTRAINT customers_billing_mode_check
    CHECK (billing_mode IS NULL OR billing_mode IN ('monthly_membership', 'per_visit', 'per_application', 'annual_prepay', 'one_time'))
  `);

  const hasPayments = await knex.schema.hasTable('payments');
  if (!hasPayments) return;
  await knex.raw(`
    UPDATE customers SET billing_mode = 'monthly_membership'
    WHERE billing_mode IS NULL
      AND deleted_at IS NULL
      AND id IN (
        SELECT DISTINCT customer_id FROM payments
        WHERE status IN ('paid', 'processing')
          AND description LIKE '%WaveGuard Monthly%'
      )
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;
  const hasMode = await knex.schema.hasColumn('customers', 'billing_mode');
  if (!hasMode) return;

  // The new lane values must be cleared before the narrower CHECK can be
  // re-added; backfilled memberships revert to NULL (legacy inference gives
  // them identical behavior).
  await knex('customers').whereIn('billing_mode', ['per_visit', 'one_time']).update({ billing_mode: null });
  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_mode_check');
  await knex.raw(`
    ALTER TABLE customers
    ADD CONSTRAINT customers_billing_mode_check
    CHECK (billing_mode IS NULL OR billing_mode IN ('monthly_membership', 'per_application', 'annual_prepay'))
  `);
};
