/**
 * customers.billing_mode + customers.per_application_fee
 *
 * Owner ruling 2026-07-09: estimate-flow customers are billed PER VISIT
 * (setup fee + first application at acceptance, then the bare application
 * fee auto-collected on each completion), never as a monthly membership
 * subscription. The monthly billing cron and the completion billing path
 * need an explicit discriminator:
 *
 *   - 'monthly_membership'  legacy WaveGuard members billed monthly by the
 *                           8AM cron (NULL is treated the same, preserving
 *                           legacy behavior for unclassified rows)
 *   - 'per_application'     estimate-flow standard accepts: each completed
 *                           visit bills per_application_fee (auto-charged
 *                           to the saved autopay card when one exists,
 *                           invoiced otherwise); the monthly cron skips them
 *   - 'annual_prepay'       live annual-prepay customers; the monthly cron
 *                           skips them (belt-and-suspenders on top of the
 *                           existing term-based guards)
 *
 * per_application_fee is the exact per-visit charge resolved at acceptance
 * (resolveBillingCadence().amount — quarterly $98.00-style exact interval
 * price, monthly = the quoted monthly). NULL means "no fee on file" and the
 * completion path falls back to its existing rate precedence.
 *
 * No backfill here: existing customers are classified in a separate
 * owner-authorized step. New accepts stamp these fields going forward.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;

  const hasMode = await knex.schema.hasColumn('customers', 'billing_mode');
  if (!hasMode) {
    await knex.schema.alterTable('customers', (table) => {
      table.text('billing_mode').nullable();
    });
    await knex.raw(`
      ALTER TABLE customers
      ADD CONSTRAINT customers_billing_mode_check
      CHECK (billing_mode IS NULL OR billing_mode IN ('monthly_membership', 'per_application', 'annual_prepay'))
    `);
  }

  const hasFee = await knex.schema.hasColumn('customers', 'per_application_fee');
  if (!hasFee) {
    await knex.schema.alterTable('customers', (table) => {
      table.decimal('per_application_fee', 10, 2).nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('customers');
  if (!hasTable) return;

  const hasMode = await knex.schema.hasColumn('customers', 'billing_mode');
  if (hasMode) {
    await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_mode_check');
    await knex.schema.alterTable('customers', (table) => {
      table.dropColumn('billing_mode');
    });
  }

  const hasFee = await knex.schema.hasColumn('customers', 'per_application_fee');
  if (hasFee) {
    await knex.schema.alterTable('customers', (table) => {
      table.dropColumn('per_application_fee');
    });
  }
};
