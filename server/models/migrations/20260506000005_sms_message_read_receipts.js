exports.up = async function up(knex) {
  const hasMessages = await knex.schema.hasTable('messages');
  if (!hasMessages) return;

  const hasReadAt = await knex.schema.hasColumn('messages', 'read_at');
  const hasReadBy = await knex.schema.hasColumn('messages', 'read_by_admin_user_id');
  const hasUpdatedAt = await knex.schema.hasColumn('messages', 'updated_at');

  await knex.schema.alterTable('messages', (t) => {
    if (!hasReadAt) t.timestamp('read_at', { useTz: true }).nullable();
    if (!hasReadBy) {
      t.uuid('read_by_admin_user_id')
        .references('id')
        .inTable('technicians')
        .onDelete('SET NULL');
    }
    if (!hasUpdatedAt) t.timestamp('updated_at', { useTz: true }).nullable();
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS messages_sms_unread_receipts
      ON messages (conversation_id, created_at DESC)
      WHERE channel = 'sms' AND direction = 'inbound' AND (is_read = false OR is_read IS NULL)
  `);
};

exports.down = async function down(knex) {
  const hasMessages = await knex.schema.hasTable('messages');
  if (!hasMessages) return;

  await knex.raw('DROP INDEX IF EXISTS messages_sms_unread_receipts');
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('read_by_admin_user_id');
    t.dropColumn('read_at');
  });
};
