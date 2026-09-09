exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('notification_prefs', 'request_channel'))) {
    await knex.schema.alterTable('notification_prefs', (t) => t.string('request_channel', 10).defaultTo('email'));
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('notification_prefs', 'request_channel')) {
    await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn('request_channel'));
  }
};
