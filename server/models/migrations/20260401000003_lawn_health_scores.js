/**
 * Lawn Health Scores — tracks turf density, weed suppression, fungus control, thatch
 * progress over time per customer.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('lawn_health_scores', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
    t.date('assessment_date').notNullable();
    t.integer('turf_density').notNullable();       // 0-100
    t.integer('weed_suppression').notNullable();    // 0-100
    t.integer('fungus_control').notNullable();      // 0-100
    t.integer('thatch_score').notNullable();        // 0-100
    t.decimal('thatch_inches', 4, 2);              // actual measurement in inches
    t.integer('overall_score');                     // 0-100, calculated average
    t.text('notes');
    t.timestamps(true, true);

    t.index(['customer_id', 'assessment_date']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('lawn_health_scores');
};
