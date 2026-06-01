exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  if (!(await knex.schema.hasTable('review_incentive_payouts'))) {
    await knex.schema.createTable('review_incentive_payouts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
      t.uuid('review_request_id').references('id').inTable('review_requests').onDelete('SET NULL');
      t.uuid('google_review_id').references('id').inTable('google_reviews').onDelete('SET NULL');
      t.string('source', 30).notNullable().defaultTo('google_review');
      t.integer('amount_cents').notNullable().defaultTo(500);
      t.string('currency', 3).notNullable().defaultTo('USD');
      t.string('status', 30).notNullable().defaultTo('earned');
      t.timestamp('earned_at').notNullable().defaultTo(knex.fn.now());
      t.date('pay_period_start');
      t.date('pay_period_end');
      t.timestamp('exported_at');
      t.timestamp('paid_at');
      t.uuid('paid_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.text('notes');
      t.jsonb('attribution_snapshot');
      t.timestamps(true, true);

      t.index(['technician_id', 'earned_at'], 'idx_review_incentive_payouts_tech_earned');
      t.index(['status', 'earned_at'], 'idx_review_incentive_payouts_status_earned');
      t.index('customer_id', 'idx_review_incentive_payouts_customer');
    });

    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_review_incentive_payouts_google_review
      ON review_incentive_payouts (google_review_id)
      WHERE google_review_id IS NOT NULL
    `);
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings')
      .insert({
        key: 'review_incentives.policy',
        value: JSON.stringify({
          enabled: true,
          amountCents: 500,
          currency: 'USD',
          eligibleSources: ['google_review'],
          minRating: 1,
          requireCustomerMatchForGoogle: true,
        }),
        category: 'reviews',
        description: 'Technician review incentive automation policy',
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .onConflict('key')
      .ignore();
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_review_incentive_payouts_google_review');
  await knex.raw('DROP INDEX IF EXISTS uq_review_incentive_payouts_review_request');
  await knex.schema.dropTableIfExists('review_incentive_payouts');

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: 'review_incentives.policy' }).del();
  }
};
