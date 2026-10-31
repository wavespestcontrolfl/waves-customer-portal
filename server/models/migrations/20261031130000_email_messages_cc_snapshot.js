// Records the CC addresses a template email went to (email_template_library.sendTemplate's `cc`).
// The invoice Send can now CC one extra address; the row keeps who got the copy next to
// recipient_email_snapshot. NULL = no CC (every row before this one, and every send without a CC).
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('email_messages', 'cc_email_snapshot');
  if (!has) {
    await knex.schema.alterTable('email_messages', (table) => {
      table.jsonb('cc_email_snapshot').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('email_messages', 'cc_email_snapshot');
  if (has) {
    await knex.schema.alterTable('email_messages', (table) => {
      table.dropColumn('cc_email_snapshot');
    });
  }
};
