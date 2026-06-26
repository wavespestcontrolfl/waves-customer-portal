/**
 * Per-customer opt-in for the "tech arrived / on site" SMS.
 *
 * Separate toggle from tech_en_route (owner directive 2026-06-25): the
 * arrival text is its own appointment-progress message a customer can
 * mute independently of the en-route text. Default true so existing
 * opted-in customers receive it; the master sms_enabled flag and STOP
 * still override. sendTechArrived() gates on this column.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('notification_prefs', 'tech_arrived');
  if (hasColumn) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.boolean('tech_arrived').defaultTo(true);
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('notification_prefs', 'tech_arrived');
  if (!hasColumn) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.dropColumn('tech_arrived');
  });
};
