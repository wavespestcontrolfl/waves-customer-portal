/**
 * Durable record that a pending review booking was confirmed FROM THE FIELD
 * (a technician tapping En Route / On Site), not by the office.
 *
 * The distinction is load-bearing for the card-on-file funnel: a field confirm
 * skips it entirely — the tech is driving to the customer and collects a card
 * in person (owner decision, PR #3356). That mode used to live only in the
 * calling route's in-memory `skipCardRequest` option, so when a core leg
 * failed and the HOURLY SWEEP retried the activation, the retry ran without it
 * and pushed the field-confirmed booking through the funnel anyway. The stamp
 * is written in the same transaction as the field confirmation; every
 * activation rail reads it and re-applies the mode.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('scheduled_services', 'field_confirmed_at')) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('field_confirmed_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('scheduled_services', 'field_confirmed_at'))) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('field_confirmed_at');
  });
};
