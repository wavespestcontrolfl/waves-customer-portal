/** Explicit invoice App choice; existing invoice text/email delivery is the default. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'invoice_channel'))) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.string('invoice_channel', 10).notNullable().defaultTo('sms');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'invoice_channel')) {
    await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn('invoice_channel'));
  }
};
