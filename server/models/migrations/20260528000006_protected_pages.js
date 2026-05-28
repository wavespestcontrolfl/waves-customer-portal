exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('protected_pages');
  if (!exists) {
    await knex.schema.createTable('protected_pages', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('page_url').notNullable().unique();
      t.string('reason').notNullable();
      t.string('added_by');
      t.text('notes');
      t.jsonb('signal_metadata').notNullable().defaultTo('{}');
      t.timestamps(true, true);
    });
  }

  await knex.schema.raw('CREATE INDEX IF NOT EXISTS protected_pages_reason_idx ON protected_pages (reason)');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('protected_pages');
};
