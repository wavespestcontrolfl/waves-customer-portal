/**
 * Weekly days off (owner ask 2026-07-23): recurring weekday closures that sit
 * alongside one-off blackout dates. Any day-of-week listed here is removed
 * from every CUSTOMER-FACING offer surface — /book, reschedule links,
 * estimate slots, Waves AI searches — plus the signed-offer redemption and
 * commit re-checks, all through the shared scheduling/blackout-dates.js
 * helpers. Admin manual scheduling stays unblocked, matching one-off
 * blackout dates: the owner can still book his own day off on purpose.
 *
 * Stored as a JSON array of JS day-of-week ints (0=Sun … 6=Sat) in the
 * system_settings key/value store. Seeded to Sat+Sun at the owner's explicit
 * direction ("flip sat/sun off", 2026-07-23). Managed from
 * /admin/settings?tab=blackout-days — unchecking a day there reopens it
 * without a deploy.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings')
    .insert({
      key: 'schedule_weekly_days_off',
      value: JSON.stringify([0, 6]),
      category: 'scheduling',
      description: 'JS day-of-week ints (0=Sun…6=Sat) removed from every customer-facing offer surface',
    })
    .onConflict('key')
    .ignore();
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where('key', 'schedule_weekly_days_off').del();
};
