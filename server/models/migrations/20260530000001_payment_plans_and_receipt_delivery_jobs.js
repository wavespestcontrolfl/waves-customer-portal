exports.up = async function up(knex) {
  await knex.schema.createTable('payment_plans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().index();
    t.uuid('invoice_id').index();
    t.uuid('payment_method_id').index();
    t.decimal('total_balance', 10, 2).notNullable();
    t.decimal('payment_amount', 10, 2).notNullable();
    t.string('payment_frequency', 40).notNullable();
    t.date('plan_start_date').notNullable();
    t.date('next_payment_date').notNullable();
    t.string('status', 40).notNullable().defaultTo('active').index();
    t.text('notes');
    t.string('created_by', 200);
    t.uuid('created_by_user_id');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('receipt_delivery_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('invoice_id').notNullable();
    t.string('stripe_payment_intent_id', 255);
    t.string('source', 80).notNullable().defaultTo('stripe_webhook');
    t.string('status', 40).notNullable().defaultTo('queued').index();
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(5);
    t.timestamp('next_attempt_at').notNullable().defaultTo(knex.fn.now()).index();
    t.timestamp('locked_at');
    t.string('locked_by', 120);
    t.text('last_error');
    t.jsonb('sms_result');
    t.jsonb('email_result');
    t.timestamp('completed_at');
    t.timestamps(true, true);
    t.unique(['invoice_id', 'source']);
    t.index(['status', 'next_attempt_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('receipt_delivery_jobs');
  await knex.schema.dropTableIfExists('payment_plans');
};
