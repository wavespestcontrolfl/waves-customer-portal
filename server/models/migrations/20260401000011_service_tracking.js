/**
 * Service Tracking — Domino's-style real-time service progress
 */
exports.up = async function (knex) {
  await knex.schema.createTable('service_tracking', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('technician_id').references('id').inTable('technicians');
    t.integer('current_step').defaultTo(1); // 1-7
    t.timestamp('step_1_at'); // Scheduled
    t.timestamp('step_2_at'); // Confirmed
    t.timestamp('step_3_at'); // En Route
    t.timestamp('step_4_at'); // On-Site
    t.timestamp('step_5_at'); // In Progress
    t.timestamp('step_6_at'); // Wrapping Up
    t.timestamp('step_7_at'); // Complete
    t.integer('eta_minutes');
    t.jsonb('live_notes').defaultTo('[]');
    t.jsonb('service_summary');
    t.timestamps(true, true);

    t.index('customer_id');
    t.index('scheduled_service_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('service_tracking');
};
