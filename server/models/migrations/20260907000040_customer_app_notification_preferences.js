/** Customer native-push preference. Existing device opt-ins retain their behavior. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'push_enabled'))) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.boolean('push_enabled').notNullable().defaultTo(true);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'push_enabled')) {
    await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn('push_enabled'));
  }
};
