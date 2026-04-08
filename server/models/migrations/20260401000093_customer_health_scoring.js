exports.up = function(knex) {
  return knex.schema
    .createTable('customer_health_scores', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().unique().references('id').inTable('customers').onDelete('CASCADE');
      t.integer('overall_score').notNullable().defaultTo(50);
      t.string('score_grade', 1).notNullable().defaultTo('C');
      t.integer('payment_score').notNullable().defaultTo(50);
      t.integer('service_score').notNullable().defaultTo(50);
      t.integer('engagement_score').notNullable().defaultTo(50);
      t.integer('satisfaction_score').notNullable().defaultTo(50);
      t.integer('loyalty_score').notNullable().defaultTo(50);
      t.integer('growth_score').notNullable().defaultTo(50);
      t.jsonb('payment_details');
      t.jsonb('service_details');
      t.jsonb('engagement_details');
      t.jsonb('satisfaction_details');
      t.jsonb('loyalty_details');
      t.jsonb('growth_details');
      t.string('churn_risk', 10).notNullable().defaultTo('low');
      t.decimal('churn_probability', 5, 4);
      t.jsonb('churn_signals');
      t.integer('days_until_predicted_churn');
      t.string('score_trend', 10).defaultTo('stable');
      t.integer('previous_score');
      t.integer('score_change_30d');
      t.timestamp('scored_at').notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);
      t.index('churn_risk');
      t.index('overall_score');
      t.index('score_grade');
    })
    .createTable('customer_health_history', t => {
      t.increments('id');
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.integer('overall_score').notNullable();
      t.integer('payment_score');
      t.integer('service_score');
      t.integer('engagement_score');
      t.integer('satisfaction_score');
      t.integer('loyalty_score');
      t.integer('growth_score');
      t.string('churn_risk', 10);
      t.date('scored_at').notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['customer_id', 'scored_at']);
      t.index('scored_at');
    })
    .createTable('customer_health_alerts', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('alert_type', 30).notNullable();
      t.string('severity', 10).notNullable();
      t.string('title', 300).notNullable();
      t.text('description');
      t.jsonb('trigger_data');
      t.jsonb('recommended_actions');
      t.string('status', 20).defaultTo('new');
      t.string('resolved_by', 100);
      t.timestamp('resolved_at');
      t.text('resolution_notes');
      t.jsonb('auto_action_taken');
      t.timestamps(true, true);
      t.index('status');
      t.index('severity');
      t.index('customer_id');
      t.index('alert_type');
    })
    .createTable('customer_save_sequences', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('trigger_alert_id').references('id').inTable('customer_health_alerts');
      t.string('sequence_type', 30).notNullable();
      t.string('status', 20).defaultTo('active');
      t.integer('current_step').defaultTo(1);
      t.integer('total_steps').notNullable();
      t.jsonb('steps').notNullable();
      t.timestamp('started_at').defaultTo(knex.fn.now());
      t.timestamp('completed_at');
      t.string('outcome', 20);
      t.text('outcome_notes');
      t.timestamps(true, true);
      t.index('customer_id');
      t.index('status');
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('customer_save_sequences')
    .dropTableIfExists('customer_health_alerts')
    .dropTableIfExists('customer_health_history')
    .dropTableIfExists('customer_health_scores');
};
