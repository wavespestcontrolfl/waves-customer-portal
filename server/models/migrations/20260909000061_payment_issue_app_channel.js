// Null preserves the existing billing preference until this choice is edited.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'payment_issue_channel'))) {
    await knex.schema.alterTable('notification_prefs', (t) => t.string('payment_issue_channel', 10));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'payment_issue_channel')) {
    await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn('payment_issue_channel'));
  }
};
