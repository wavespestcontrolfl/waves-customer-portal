/**
 * Migration — Per-invoice follow-up sequences
 *
 * Each unpaid invoice gets its own automated reminder chain (Day 0, 3, 7, 14, 30).
 * Stops the moment the invoice is paid. Autopay-aware: paused while a saved
 * payment method is being retried; unpaused after 3 failed autopay attempts.
 *
 * Virginia can pause / advance / stop per-invoice from the admin UI.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('invoice_followup_sequences');
  if (exists) return;

  await knex.schema.createTable('invoice_followup_sequences', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('invoice_id').notNullable().references('id').inTable('invoices').onDelete('CASCADE');
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');

    // Lifecycle state
    t.string('status', 20).notNullable().defaultTo('active');
    // active | paused | stopped | completed | autopay_hold

    t.integer('step_index').notNullable().defaultTo(0); // next step to fire (0 = first)
    t.timestamp('next_touch_at'); // when step_index is due
    t.timestamp('last_touch_at');
    t.integer('touches_sent').notNullable().defaultTo(0);

    // Virginia controls
    t.text('paused_reason');        // free-text (e.g. "customer said they'll pay Friday")
    t.timestamp('paused_until');    // auto-resume at this time
    t.text('stopped_reason');       // e.g. "waived" / "customer disputed"
    t.uuid('paused_by_admin_id');
    t.uuid('stopped_by_admin_id');

    // Autopay awareness
    t.boolean('is_autopay_held').notNullable().defaultTo(false);
    t.integer('autopay_failures_observed').notNullable().defaultTo(0);

    t.timestamps(true, true);

    t.unique('invoice_id');           // one sequence per invoice
    t.index('status');
    t.index('next_touch_at');
    t.index('customer_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('invoice_followup_sequences');
};
