/**
 * Email-division area intelligence: one row per (month, city, pest_key) —
 * visits that month for that city, and how many named that pest in
 * technician_notes. City-level only, no customer ids/addresses/names (see
 * server/services/email-division/area-intel.js, 5-visit floor). unique
 * (month, city, pest_key) makes the nightly recompute an upsert.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_area_intel_monthly')) return;

  await knex.schema.createTable('email_area_intel_monthly', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.date('month').notNullable(); // first of the ET calendar month
    t.text('city').notNullable(); // normalised lower-case, trimmed
    t.integer('visits').notNullable();
    t.text('pest_key').notNullable(); // canonical pest keyword, e.g. 'big-headed ants'
    t.integer('visits_with_pest').notNullable();
    t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['month', 'city', 'pest_key'], 'uq_email_area_intel_monthly_month_city_pest');
    t.index(['city', 'month'], 'idx_email_area_intel_monthly_city_month');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_area_intel_monthly');
};
