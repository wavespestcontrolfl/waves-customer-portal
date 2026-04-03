/**
 * Onboarding sessions + enhanced property preferences + customer attribution
 */
exports.up = async function (knex) {
  // Onboarding sessions
  await knex.schema.createTable('onboarding_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('token', 64).notNullable().unique();
    t.string('quote_reference', 100);
    t.string('service_type', 200).notNullable();
    t.string('waveguard_tier', 20);
    t.decimal('monthly_rate', 10, 2);
    t.decimal('deposit_amount', 10, 2);
    t.enu('status', ['started', 'payment_complete', 'service_confirmed', 'details_complete', 'complete']).defaultTo('started');
    t.boolean('payment_collected').defaultTo(false);
    t.boolean('service_confirmed').defaultTo(false);
    t.boolean('details_collected').defaultTo(false);
    t.timestamp('started_at').defaultTo(knex.fn.now());
    t.timestamp('completed_at');
    t.timestamp('expires_at');
    t.timestamps(true, true);

    t.index('token');
    t.index('customer_id');
  });

  // Enhanced property preferences
  await knex.schema.alterTable('property_preferences', (t) => {
    t.enu('typically_home', ['yes', 'no', 'varies']).nullable();
    t.enu('interior_access_method', ['home', 'garage_code', 'lockbox', 'hidden_key']).nullable();
    t.string('interior_access_details', 200);
    t.boolean('chemical_sensitivities').defaultTo(false);
    t.text('chemical_sensitivity_details');
    t.jsonb('special_features').defaultTo('[]');
  });

  // Customer attribution
  await knex.schema.alterTable('customers', (t) => {
    t.string('referral_source', 50);
    t.uuid('referred_by_customer_id').references('id').inTable('customers');
    t.boolean('onboarding_complete').defaultTo(false);
    t.timestamp('onboarded_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('onboarding_sessions');
  await knex.schema.alterTable('property_preferences', (t) => {
    t.dropColumn('typically_home');
    t.dropColumn('interior_access_method');
    t.dropColumn('interior_access_details');
    t.dropColumn('chemical_sensitivities');
    t.dropColumn('chemical_sensitivity_details');
    t.dropColumn('special_features');
  });
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('referral_source');
    t.dropColumn('referred_by_customer_id');
    t.dropColumn('onboarding_complete');
    t.dropColumn('onboarded_at');
  });
};
