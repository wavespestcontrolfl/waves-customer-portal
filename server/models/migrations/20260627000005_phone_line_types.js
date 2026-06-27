/**
 * phone_line_types — a phone-keyed cache of Twilio Lookup line-type results.
 *
 * Backs the proactive line-type guard (validators/line-type.js): before the
 * first SMS to a number we look up its line type and skip landlines. Caching by
 * PHONE (not customer) means a number is looked up at most once ever, and the
 * cache works uniformly for customers, leads, and service-contact numbers — none
 * of which share the customers.line_type primary-phone cache.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('phone_line_types')) return;
  await knex.schema.createTable('phone_line_types', (t) => {
    t.string('phone', 32).primary();          // normalized E.164
    t.string('line_type', 24).notNullable();  // Twilio line_type_intelligence type: landline|mobile|voip|tollFree|...
    t.timestamp('checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('phone_line_types');
};
