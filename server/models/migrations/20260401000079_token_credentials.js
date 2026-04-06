exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('token_credentials');
  if (!hasTable) {
    await knex.schema.createTable('token_credentials', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('platform', 30).notNullable();
      t.string('token_type', 30);
      t.string('status', 20).defaultTo('unknown');
      t.timestamp('last_verified_at');
      t.text('last_error');
      t.timestamp('expires_at');
      t.string('env_var_name', 100);
      t.text('notes');
      t.timestamps(true, true);
    });

    await knex.schema.alterTable('token_credentials', (t) => {
      t.unique('platform');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('token_credentials');
};
