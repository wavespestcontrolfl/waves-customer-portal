exports.up = async function (knex) {
  const cols = await knex('information_schema.columns')
    .where({ table_name: 'blog_posts', table_schema: 'public' })
    .select('column_name');
  const existing = new Set(cols.map(c => c.column_name));

  await knex.schema.alterTable('blog_posts', t => {
    if (!existing.has('shared_to_social')) {
      t.boolean('shared_to_social').notNullable().defaultTo(false);
    }
    if (!existing.has('shared_at')) {
      t.timestamp('shared_at', { useTz: true });
    }
  });
};

exports.down = async function (knex) {
  const cols = await knex('information_schema.columns')
    .where({ table_name: 'blog_posts', table_schema: 'public' })
    .select('column_name');
  const existing = new Set(cols.map(c => c.column_name));

  await knex.schema.alterTable('blog_posts', t => {
    if (existing.has('shared_to_social')) t.dropColumn('shared_to_social');
    if (existing.has('shared_at')) t.dropColumn('shared_at');
  });
};
