/**
 * Migration 038 — Dispatch Optimization Module
 *
 * Tables:
 *  - dispatch_technicians   (tech profiles with licenses, territories, metrics)
 *  - dispatch_jobs          (jobs to dispatch with scoring)
 *  - dispatch_route_sessions (optimized route snapshots)
 *  - dispatch_csr_bookings  (CSR booking recommendations)
 *
 * Note: knowledge_base and knowledge_queries already exist from migration 035.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('dispatch_technicians', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('color').defaultTo('#0e8c6a');
    t.jsonb('licenses').defaultTo('[]');
    t.jsonb('service_lines').defaultTo('[]');
    t.jsonb('territory_zips').defaultTo('[]');
    t.string('territory_label');
    t.float('upsell_rate').defaultTo(0);
    t.float('completion_rate').defaultTo(0);
    t.float('callback_rate').defaultTo(0);
    t.float('revenue_per_hour').defaultTo(0);
    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('dispatch_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('sheet_row_id').nullable();
    t.string('customer_name').notNullable();
    t.string('address').notNullable();
    t.string('city');
    t.string('zip');
    t.float('lat').nullable();
    t.float('lng').nullable();
    t.string('service_type').notNullable();
    t.string('job_category').defaultTo('recurring');
    t.string('waveguard_tier').defaultTo('none');
    t.uuid('assigned_tech_id').nullable().references('id').inTable('dispatch_technicians').onDelete('SET NULL');
    t.string('scheduled_date');
    t.string('scheduled_time');
    t.integer('estimated_duration').defaultTo(45);
    t.integer('route_position').nullable();
    t.integer('job_score').nullable();
    t.jsonb('score_breakdown').defaultTo('{}');
    t.jsonb('upsell_flags').defaultTo('[]');
    t.string('status').defaultTo('scheduled');
    t.uuid('original_tech_id').nullable();
    t.boolean('is_high_value').defaultTo(false);
    t.decimal('estimated_revenue', 10, 2).defaultTo(0);
    t.text('notes');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('dispatch_route_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('date').notNullable();
    t.uuid('tech_id').references('id').inTable('dispatch_technicians');
    t.string('mode').defaultTo('mixed');
    t.string('zone').defaultTo('all');
    t.jsonb('job_order').defaultTo('[]');
    t.integer('total_jobs').defaultTo(0);
    t.integer('estimated_miles').defaultTo(0);
    t.float('drive_time_pct').defaultTo(0);
    t.decimal('expected_revenue', 10, 2).defaultTo(0);
    t.float('revenue_per_hour').defaultTo(0);
    t.string('optimized_by').defaultTo('manual');
    t.text('optimization_notes');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('dispatch_csr_bookings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('scenario').notNullable();
    t.string('service_type');
    t.string('zip');
    t.jsonb('recommended_slots').defaultTo('[]');
    t.string('slot_selected').nullable();
    t.uuid('booked_tech_id').nullable();
    t.boolean('converted').defaultTo(false);
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('dispatch_csr_bookings');
  await knex.schema.dropTableIfExists('dispatch_route_sessions');
  await knex.schema.dropTableIfExists('dispatch_jobs');
  await knex.schema.dropTableIfExists('dispatch_technicians');
};
