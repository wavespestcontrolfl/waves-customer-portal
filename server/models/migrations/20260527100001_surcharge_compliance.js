/**
 * Surcharge Compliance — schema additions for credit-card-only surcharging.
 *
 * 1. payment_methods: card_funding + card_funding_checked_at
 *    Stores the Stripe-reported funding type ('credit', 'debit', 'prepaid')
 *    so charge paths can decide whether a surcharge applies.
 *
 * 2. payments: surcharge tracking columns
 *    Stores surcharge facts at charge time — admin UI, refunds, bypass
 *    detection, and reconciliation read these instead of recomputing.
 */
exports.up = async function (knex) {
  // ── payment_methods ─────────────────────────────────────────
  if (!(await knex.schema.hasColumn('payment_methods', 'card_funding'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('card_funding', 10).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'card_funding_checked_at'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.timestamp('card_funding_checked_at', { useTz: true }).nullable();
    });
  }

  // ── payments ────────────────────────────────────────────────
  const paymentsColumns = [
    ['base_amount_cents', (t) => t.integer('base_amount_cents').nullable()],
    ['surcharge_amount_cents', (t) => t.integer('surcharge_amount_cents').defaultTo(0)],
    ['surcharge_rate_bps', (t) => t.integer('surcharge_rate_bps').defaultTo(0)],
    ['surcharge_policy_version', (t) => t.string('surcharge_policy_version', 20).nullable()],
    ['card_funding', (t) => t.string('card_funding', 10).nullable()],
    ['card_country', (t) => t.string('card_country', 2).nullable()],
    ['stripe_surcharge_status', (t) => t.string('stripe_surcharge_status', 20).nullable()],
    ['stripe_surcharge_maximum_amount_cents', (t) => t.integer('stripe_surcharge_maximum_amount_cents').nullable()],
    ['refunded_base_cents', (t) => t.integer('refunded_base_cents').defaultTo(0)],
    ['refunded_surcharge_cents', (t) => t.integer('refunded_surcharge_cents').defaultTo(0)],
  ];

  for (const [col, addCol] of paymentsColumns) {
    if (!(await knex.schema.hasColumn('payments', col))) {
      await knex.schema.alterTable('payments', (t) => addCol(t));
    }
  }

  // card_brand may already exist from the Square import migration — add if missing
  if (!(await knex.schema.hasColumn('payments', 'card_brand'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.string('card_brand', 20).nullable();
    });
  }
};

exports.down = async function (knex) {
  const paymentsCols = [
    'base_amount_cents', 'surcharge_amount_cents', 'surcharge_rate_bps',
    'surcharge_policy_version', 'card_funding', 'card_country',
    'stripe_surcharge_status', 'stripe_surcharge_maximum_amount_cents',
    'refunded_base_cents', 'refunded_surcharge_cents',
  ];
  for (const col of paymentsCols) {
    if (await knex.schema.hasColumn('payments', col)) {
      await knex.schema.alterTable('payments', (t) => t.dropColumn(col));
    }
  }

  if (await knex.schema.hasColumn('payment_methods', 'card_funding')) {
    await knex.schema.alterTable('payment_methods', (t) => t.dropColumn('card_funding'));
  }
  if (await knex.schema.hasColumn('payment_methods', 'card_funding_checked_at')) {
    await knex.schema.alterTable('payment_methods', (t) => t.dropColumn('card_funding_checked_at'));
  }
};
