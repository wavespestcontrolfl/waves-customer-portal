/**
 * Surcharge Compliance - schema additions for credit-card-only surcharging.
 *
 * Keep this migration present on main because production has already recorded
 * the filename in knex_migrations. The body is idempotent for safe re-runs.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('payment_methods', 'card_funding'))) {
    await knex.schema.alterTable('payment_methods', (table) => {
      table.string('card_funding', 10).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('payment_methods', 'card_funding_checked_at'))) {
    await knex.schema.alterTable('payment_methods', (table) => {
      table.timestamp('card_funding_checked_at', { useTz: true }).nullable();
    });
  }

  const paymentsColumns = [
    ['base_amount_cents', (table) => table.integer('base_amount_cents').nullable()],
    ['surcharge_amount_cents', (table) => table.integer('surcharge_amount_cents').defaultTo(0)],
    ['surcharge_rate_bps', (table) => table.integer('surcharge_rate_bps').defaultTo(0)],
    ['surcharge_policy_version', (table) => table.string('surcharge_policy_version', 20).nullable()],
    ['card_funding', (table) => table.string('card_funding', 10).nullable()],
    ['card_country', (table) => table.string('card_country', 2).nullable()],
    ['stripe_surcharge_status', (table) => table.string('stripe_surcharge_status', 20).nullable()],
    ['stripe_surcharge_maximum_amount_cents', (table) => table.integer('stripe_surcharge_maximum_amount_cents').nullable()],
    ['refunded_base_cents', (table) => table.integer('refunded_base_cents').defaultTo(0)],
    ['refunded_surcharge_cents', (table) => table.integer('refunded_surcharge_cents').defaultTo(0)],
  ];

  for (const [column, addColumn] of paymentsColumns) {
    if (!(await knex.schema.hasColumn('payments', column))) {
      await knex.schema.alterTable('payments', (table) => addColumn(table));
    }
  }

  if (!(await knex.schema.hasColumn('payments', 'card_brand'))) {
    await knex.schema.alterTable('payments', (table) => {
      table.string('card_brand', 20).nullable();
    });
  }
};

exports.down = async function (knex) {
  const paymentsColumns = [
    'base_amount_cents',
    'surcharge_amount_cents',
    'surcharge_rate_bps',
    'surcharge_policy_version',
    'card_funding',
    'card_country',
    'stripe_surcharge_status',
    'stripe_surcharge_maximum_amount_cents',
    'refunded_base_cents',
    'refunded_surcharge_cents',
  ];

  for (const column of paymentsColumns) {
    if (await knex.schema.hasColumn('payments', column)) {
      await knex.schema.alterTable('payments', (table) => table.dropColumn(column));
    }
  }

  if (await knex.schema.hasColumn('payment_methods', 'card_funding')) {
    await knex.schema.alterTable('payment_methods', (table) => table.dropColumn('card_funding'));
  }

  if (await knex.schema.hasColumn('payment_methods', 'card_funding_checked_at')) {
    await knex.schema.alterTable('payment_methods', (table) => table.dropColumn('card_funding_checked_at'));
  }
};
