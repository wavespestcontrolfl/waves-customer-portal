/**
 * Owner ruling 2026-09-29: the first-visit default pest rating (owner ruling
 * 2026-09-24 — a customer's first visit on a service line starts the
 * technician rating at 5, applied automatically unless the tech changes it,
 * server/services/pest-pressure/first-visit.js) must not count in the
 * email-division pest activity averages (getActivityRatingAverages,
 * server/services/email-division/visit-products.js). A 5 the technician
 * deliberately chose still counts.
 *
 * Schema only: a nullable boolean on service_records marking whether the
 * completion write that stored client_pest_rating was the untouched
 * first-visit default (true), a rating the tech actually chose — including
 * a deliberately re-entered 5 — (false), or unknown/not applicable because
 * the row predates this column (NULL, no backfill). The Pest Pressure engine,
 * the report's pest pressure score, and the recap are NOT changed by this
 * column — they keep reading client_pest_rating/_source exactly as before
 * (the 2026-09-24 ruling stands there; the recap already hides the default
 * from the customer).
 */

async function addColumnIfMissing(knex, table, name, add) {
  if (!(await knex.schema.hasColumn(table, name))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function dropColumnIfPresent(knex, table, name) {
  if (await knex.schema.hasColumn(table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

exports.up = async function up(knex) {
  await addColumnIfMissing(knex, 'service_records', 'client_pest_rating_defaulted', (t) => {
    t.boolean('client_pest_rating_defaulted');
  });
};

exports.down = async function down(knex) {
  await dropColumnIfPresent(knex, 'service_records', 'client_pest_rating_defaulted');
};
