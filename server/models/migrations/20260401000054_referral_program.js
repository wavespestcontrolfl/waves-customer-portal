/**
 * Migration 054 — Referral Program (Clicki integration)
 */
exports.up = async function (knex) {
  // Promoters: customers enrolled in the referral program
  await knex.schema.createTable('referral_promoters', t => {
    t.increments('id').primary();
    t.string('customer_phone', 20).notNullable().unique();
    t.string('customer_email');
    t.string('first_name', 100).notNullable();
    t.string('last_name', 100).notNullable();
    t.text('clicki_referral_link');
    t.string('clicki_promoter_id');
    t.string('campaign', 50).defaultTo('customer');
    t.string('status', 20).defaultTo('active');
    t.integer('click_balance_cents').defaultTo(0);
    t.integer('referral_balance_cents').defaultTo(0);
    t.integer('total_earned_cents').defaultTo(0);
    t.integer('total_paid_out_cents').defaultTo(0);
    t.integer('total_clicks').defaultTo(0);
    t.integer('total_referrals_sent').defaultTo(0);
    t.integer('total_referrals_converted').defaultTo(0);
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.timestamp('enrolled_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('status');
  });

  // Referrals: every referral submission
  if (await knex.schema.hasTable('referrals')) {
    // Table already exists from migration 007 — skip creation
  } else {
  await knex.schema.createTable('referrals', t => {
    t.increments('id').primary();
    t.string('referral_first_name', 100).notNullable();
    t.string('referral_last_name', 100);
    t.string('referral_phone', 20).notNullable();
    t.string('referral_email');
    t.text('referral_address');
    t.text('referral_notes');
    t.integer('promoter_id').references('id').inTable('referral_promoters');
    t.string('promoter_phone', 20);
    t.string('promoter_name', 200);
    t.string('source', 20).defaultTo('portal');
    t.string('clicki_referral_id');
    t.string('status', 20).defaultTo('pending');
    t.text('admin_notes');
    t.integer('reward_amount_cents');
    t.boolean('reward_paid').defaultTo(false);
    t.timestamp('reward_paid_at');
    t.string('reward_method', 20);
    t.string('square_customer_id');
    t.string('square_invoice_id');
    t.timestamps(true, true);
    t.timestamp('converted_at');
    t.index('status');
    t.index('promoter_id');
  });
  } // end if/else for referrals table

  // Click log
  await knex.schema.createTable('referral_clicks', t => {
    t.increments('id').primary();
    t.integer('promoter_id').references('id').inTable('referral_promoters');
    t.string('click_ip', 45);
    t.string('click_geo', 100);
    t.string('click_source', 100);
    t.boolean('is_verified').defaultTo(true);
    t.jsonb('raw_payload');
    t.integer('reward_amount_cents').defaultTo(50);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('promoter_id');
  });

  // Payouts
  await knex.schema.createTable('referral_payouts', t => {
    t.increments('id').primary();
    t.integer('promoter_id').references('id').inTable('referral_promoters').notNullable();
    t.integer('amount_cents').notNullable();
    t.string('method', 20).notNullable();
    t.string('status', 20).defaultTo('pending');
    t.string('square_invoice_id');
    t.string('square_order_id');
    t.string('square_discount_id');
    t.text('admin_notes');
    t.timestamp('requested_at').defaultTo(knex.fn.now());
    t.timestamp('processed_at');
    t.string('processed_by', 100);
    t.index('status');
  });

  // Program settings
  await knex.schema.createTable('referral_settings', t => {
    t.string('key', 100).primary();
    t.text('value').notNullable();
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // Seed default settings
  const settings = [
    ['reward_per_click_cents', '50'],
    ['reward_per_referral_cents', '5000'],
    ['min_payout_cents', '1000'],
    ['auto_approve_referrals', 'false'],
    ['payout_methods', '["invoice_credit","service_credit","cash"]'],
    ['waveguard_bonus_silver_cents', '5000'],
    ['waveguard_bonus_gold_cents', '7500'],
    ['waveguard_bonus_platinum_cents', '10000'],
  ];
  for (const [key, value] of settings) {
    await knex('referral_settings').insert({ key, value }).onConflict('key').ignore();
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('referral_payouts');
  await knex.schema.dropTableIfExists('referral_clicks');
  await knex.schema.dropTableIfExists('referrals');
  await knex.schema.dropTableIfExists('referral_settings');
  await knex.schema.dropTableIfExists('referral_promoters');
};
