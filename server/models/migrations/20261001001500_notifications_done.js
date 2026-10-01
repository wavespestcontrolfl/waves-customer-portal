/**
 * notifications.done_at / done_by / resolution — the "done" state for admin
 * alerts (docs/admin-notifications.md §4, owner ruling 2026-09-30). Read is
 * not done: a done row leaves the bell, whether a person marked it done or
 * the condition it was about cleared (an emitter's auto-close, the
 * relevance sweep). `done_by` names who: an admin user id, 'claude', or the
 * system component ('episodes', 'relevance', 'expiry'); `resolution` is one
 * short line of what fixed it. Nullable, additive, no backfill.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('notifications');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('notifications', 'done_at');
  if (!hasColumn) {
    await knex.schema.alterTable('notifications', (t) => {
      t.timestamp('done_at', { useTz: true }).nullable().defaultTo(null);
      t.string('done_by', 64).nullable().defaultTo(null);
      t.text('resolution').nullable().defaultTo(null);
    });
  }
  // The bell lists open admin rows: unread or recent, never done.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notifications_admin_open_idx
      ON notifications (recipient_type, created_at DESC)
      WHERE done_at IS NULL
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('notifications');
  if (!hasTable) return;

  await knex.raw('DROP INDEX IF EXISTS notifications_admin_open_idx');
  if (await knex.schema.hasColumn('notifications', 'done_at')) {
    await knex.schema.alterTable('notifications', (t) => {
      t.dropColumn('done_at');
      t.dropColumn('done_by');
      t.dropColumn('resolution');
    });
  }
};
