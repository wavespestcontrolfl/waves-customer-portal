/**
 * Stripe Payment Integration — Schema Additions
 *
 * Adds Stripe columns to payment_methods, payments, invoices, customers.
 * Creates stripe_webhook_events table for idempotent webhook processing.
 * Backfills existing Square records with processor='square'.
 */
exports.up = async function (knex) {
  // ── payment_methods ──────────────────────────────────────────
  await knex.schema.alterTable('payment_methods', (t) => {
    // Processor flag
    if (!knex.schema.hasColumn) {
      // hasColumn is async — handled below
    }
  });

  if (!(await knex.schema.hasColumn('payment_methods', 'processor'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('processor', 10).defaultTo('square');
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'stripe_payment_method_id'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('stripe_payment_method_id', 100);
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'stripe_customer_id'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('stripe_customer_id', 100);
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'method_type'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('method_type', 20).defaultTo('card');
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'bank_name'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('bank_name', 100);
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'bank_last_four'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('bank_last_four', 4);
    });
  }
  if (!(await knex.schema.hasColumn('payment_methods', 'ach_status'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.string('ach_status', 20);
    });
  }

  // Make square_card_id nullable (was NOT NULL in initial schema)
  await knex.schema.alterTable('payment_methods', (t) => {
    t.string('square_card_id', 100).nullable().alter();
  });

  // Indexes
  await knex.schema.alterTable('payment_methods', (t) => {
    t.index('processor', 'idx_pm_processor');
    t.index('stripe_payment_method_id', 'idx_pm_stripe_pm_id');
    t.index('customer_id', 'idx_pm_customer_id');
  });

  // ── payments ─────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('payments', 'processor'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.string('processor', 10);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'stripe_payment_intent_id'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.string('stripe_payment_intent_id', 100);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'stripe_charge_id'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.string('stripe_charge_id', 100);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'refund_amount'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.decimal('refund_amount', 10, 2).defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'refund_status'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.string('refund_status', 20);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'stripe_refund_id'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.string('stripe_refund_id', 100);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'failure_reason'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.text('failure_reason');
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'retry_count'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.integer('retry_count').defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('payments', 'next_retry_at'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.timestamp('next_retry_at');
    });
  }

  // ── invoices ─────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('invoices', 'processor'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.string('processor', 10);
    });
  }
  if (!(await knex.schema.hasColumn('invoices', 'stripe_payment_intent_id'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.string('stripe_payment_intent_id', 100);
    });
  }
  if (!(await knex.schema.hasColumn('invoices', 'stripe_charge_id'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.string('stripe_charge_id', 100);
    });
  }

  // ── customers ────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('customers', 'stripe_customer_id'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.string('stripe_customer_id', 100);
    });
  }
  // Index (safe — won't collide if health scoring already added column without index)
  try {
    await knex.schema.alterTable('customers', (t) => {
      t.index('stripe_customer_id', 'idx_customers_stripe_id');
    });
  } catch {
    // index may already exist
  }

  // ── stripe_webhook_events ────────────────────────────────────
  const hasWebhookTable = await knex.schema.hasTable('stripe_webhook_events');
  if (!hasWebhookTable) {
    await knex.schema.createTable('stripe_webhook_events', (t) => {
      t.string('id', 100).primary(); // Stripe event ID (evt_xxx)
      t.string('event_type', 100).notNullable();
      t.boolean('processed').defaultTo(false);
      t.jsonb('payload');
      t.text('error');
      t.timestamp('received_at').defaultTo(knex.fn.now());
      t.timestamp('processed_at');

      t.index('event_type');
      t.index('processed');
    });
  }

  // ── Backfill: tag existing records with processor='square' ──
  await knex('payment_methods')
    .whereNotNull('square_card_id')
    .whereNull('processor')
    .update({ processor: 'square' });

  await knex('payments')
    .whereNotNull('square_payment_id')
    .whereNull('processor')
    .update({ processor: 'square' });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('stripe_webhook_events');

  // Remove Stripe columns from invoices
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumns('processor', 'stripe_payment_intent_id', 'stripe_charge_id');
  });

  // Remove Stripe columns from payments
  await knex.schema.alterTable('payments', (t) => {
    t.dropColumns(
      'processor', 'stripe_payment_intent_id', 'stripe_charge_id',
      'refund_amount', 'refund_status', 'stripe_refund_id',
      'failure_reason', 'retry_count', 'next_retry_at'
    );
  });

  // Remove Stripe columns from payment_methods
  await knex.schema.alterTable('payment_methods', (t) => {
    t.dropColumns(
      'processor', 'stripe_payment_method_id', 'stripe_customer_id',
      'method_type', 'bank_name', 'bank_last_four', 'ach_status'
    );
  });

  // Remove stripe_customer_id from customers (only if we added it)
  if (await knex.schema.hasColumn('customers', 'stripe_customer_id')) {
    await knex.schema.alterTable('customers', (t) => {
      t.dropColumn('stripe_customer_id');
    });
  }
};
