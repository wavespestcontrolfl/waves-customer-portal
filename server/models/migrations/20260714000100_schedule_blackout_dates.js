/**
 * Owner blackout days (2026-07-14): dates the business takes off. Any date in
 * this table is removed from every CUSTOMER-FACING offer surface — the public
 * /book funnel, the self-serve reschedule page, estimate slot offers, and the
 * Waves AI date searches — all of which enumerate candidate dates through
 * scheduling/find-time.js (the single enforcement point). Admin-side manual
 * scheduling is deliberately NOT blocked: the owner can still book his own
 * day off on purpose.
 *
 * Managed from /admin/settings?tab=blackout-days.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('schedule_blackout_dates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.date('date').notNullable().unique();
    t.string('reason', 200);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('schedule_blackout_dates');
};
