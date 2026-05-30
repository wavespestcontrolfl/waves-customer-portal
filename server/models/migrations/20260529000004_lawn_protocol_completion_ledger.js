/**
 * Durable completion bridge for the lawn protocol operating layer.
 *
 * service_records remains the canonical visit record. These tables record
 * which structured lawn protocol window was used, what checklist evidence
 * the tech captured, and how actual/skipped products mapped back to the
 * protocol plan.
 */

exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) {
    await knex.schema.createTable('lawn_protocol_service_completions', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable()
        .references('id').inTable('service_records').onDelete('CASCADE');
      t.uuid('scheduled_service_id').nullable()
        .references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.uuid('customer_id').nullable()
        .references('id').inTable('customers').onDelete('SET NULL');
      t.uuid('lawn_protocol_id').nullable()
        .references('id').inTable('lawn_protocols').onDelete('SET NULL');
      t.uuid('lawn_protocol_window_id').nullable()
        .references('id').inTable('lawn_protocol_windows').onDelete('SET NULL');

      t.string('protocol_key', 100);
      t.string('protocol_version', 40);
      t.string('window_key', 80);
      t.string('window_title', 160);

      t.uuid('equipment_system_id').nullable();
      t.uuid('calibration_id').nullable();
      t.integer('treated_sqft').nullable();
      t.decimal('carrier_gal_per_1000', 6, 3).nullable();
      t.decimal('total_carrier_gal', 10, 3).nullable();

      t.jsonb('checklist').notNullable().defaultTo('[]');
      t.jsonb('required_tasks').notNullable().defaultTo('[]');
      t.jsonb('missing_required_tasks').notNullable().defaultTo('[]');
      t.jsonb('expected_response').notNullable().defaultTo('{}');
      t.jsonb('watch_items').notNullable().defaultTo('[]');
      t.date('recheck_due_date').nullable();
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.timestamps(true, true);

      t.unique('service_record_id');
      t.index(['customer_id', 'created_at']);
      t.index(['protocol_key', 'protocol_version']);
    });
  }

  if (!(await knex.schema.hasTable('lawn_protocol_product_actuals'))) {
    await knex.schema.createTable('lawn_protocol_product_actuals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('lawn_protocol_service_completion_id').notNullable()
        .references('id').inTable('lawn_protocol_service_completions').onDelete('CASCADE');
      t.uuid('service_product_id').nullable()
        .references('id').inTable('service_products').onDelete('SET NULL');
      t.uuid('protocol_product_id').nullable()
        .references('id').inTable('lawn_protocol_products').onDelete('SET NULL');
      t.uuid('product_id').nullable()
        .references('id').inTable('products_catalog').onDelete('SET NULL');
      t.string('product_name', 180).notNullable();
      t.string('role', 60);
      t.string('status', 30).notNullable().defaultTo('applied');
      t.decimal('planned_rate_per_1000', 10, 4).nullable();
      t.string('planned_rate_unit', 30).nullable();
      t.decimal('actual_rate_per_1000', 10, 4).nullable();
      t.string('actual_rate_unit', 30).nullable();
      t.decimal('actual_amount', 10, 4).nullable();
      t.string('actual_amount_unit', 30).nullable();
      t.text('skip_reason').nullable();
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.timestamps(true, true);

      t.index('lawn_protocol_service_completion_id', 'idx_lp_actuals_completion');
      t.index(['product_id', 'status'], 'idx_lp_actuals_product_status');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('lawn_protocol_product_actuals');
  await knex.schema.dropTableIfExists('lawn_protocol_service_completions');
};
