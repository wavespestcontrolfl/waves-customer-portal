/**
 * notifications.detail — the full body a brevity guard trims off the admin
 * bell (admin-alerts-brevity scope, owner ruling 2026-09-28). The bell shows
 * a short title/body; the Activity feed's expander and the destination page
 * read `detail || body` for the whole story. Nullable, additive, no backfill
 * — every existing row's long body stays exactly where it is; only NEW
 * admin rows split into body + detail (notification-service.js's brevity
 * guard).
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('notifications');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('notifications', 'detail');
  if (!hasColumn) {
    await knex.schema.alterTable('notifications', (t) => {
      t.text('detail').nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('notifications');
  if (!hasTable) return;

  if (await knex.schema.hasColumn('notifications', 'detail')) {
    await knex.schema.alterTable('notifications', (t) => { t.dropColumn('detail'); });
  }
};
