/**
 * Autopay Controls — customer-facing autopay transparency and admin management.
 *
 * Adds columns to `customers` for autopay state (enabled, paused, designated card,
 * billing day, cached next charge date) and creates `autopay_log` as the audit
 * trail for every autopay event — charges, skips, pauses, setting changes.
 *
 * Existing `payment_methods.autopay_enabled` column is repurposed as the
 * "is_autopay" flag (only one per customer should be true) — no new column added.
 */
exports.up = async function (knex) {
  // ── customers: autopay state ──────────────────────────────────────
  await knex.schema.alterTable('customers', (t) => {
    t.boolean('autopay_enabled').defaultTo(true);
    t.integer('billing_day').defaultTo(1); // day of month, 1-28
    t.uuid('autopay_payment_method_id').nullable();
    t.date('next_charge_date').nullable();
    t.date('autopay_paused_until').nullable();
    t.text('autopay_pause_reason').nullable();
  });

  // Backfill: default autopay_enabled = true for all existing customers
  await knex('customers').update({ autopay_enabled: true, billing_day: 1 });

  // ── autopay_log: audit trail ──────────────────────────────────────
  await knex.schema.createTable('autopay_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('event_type', 50).notNullable();
    // charge_success, charge_failed, retry_success, retry_failed,
    // autopay_enabled, autopay_disabled, autopay_paused, autopay_resumed,
    // payment_method_changed, billing_day_changed, skipped_disabled,
    // skipped_paused, skipped_no_payment_method, skipped_already_paid,
    // card_expiring_soon, card_expired, manual_charge
    t.integer('amount_cents').nullable();
    t.uuid('payment_method_id').nullable();
    t.uuid('payment_id').nullable();
    t.jsonb('details').nullable();
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index(['customer_id', 'created_at'], 'idx_autopay_log_customer');
    t.index('event_type', 'idx_autopay_log_event_type');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('autopay_log');
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('autopay_enabled');
    t.dropColumn('billing_day');
    t.dropColumn('autopay_payment_method_id');
    t.dropColumn('next_charge_date');
    t.dropColumn('autopay_paused_until');
    t.dropColumn('autopay_pause_reason');
  });
};
