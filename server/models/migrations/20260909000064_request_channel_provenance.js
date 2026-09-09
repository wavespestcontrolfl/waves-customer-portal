// NULL preserves unknown historical Email choices. Only rows created after
// this migration can identify an untouched default with false.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'request_channel_explicit'))) {
    await knex.schema.alterTable('notification_prefs', (t) => t.boolean('request_channel_explicit').nullable());
  }
  await knex.raw('ALTER TABLE ?? ALTER COLUMN ?? SET DEFAULT false', ['notification_prefs', 'request_channel_explicit']);
  if (await knex.schema.hasColumn('notification_prefs', 'request_channel')) {
    // App has never been a default. Do not restamp updated_at: it also
    // carries marketing-SMS consent provenance.
    await knex('notification_prefs').where({ request_channel: 'push' }).whereNull('request_channel_explicit')
      .update({ request_channel_explicit: true });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'request_channel_explicit')) {
    await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn('request_channel_explicit'));
  }
};
