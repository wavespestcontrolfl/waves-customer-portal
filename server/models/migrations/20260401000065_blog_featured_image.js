exports.up = async function (knex) {
  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'blog_posts'");
  const colNames = cols.rows.map(r => r.column_name);

  if (!colNames.includes('featured_image_url')) {
    await knex.schema.alterTable('blog_posts', t => {
      t.text('featured_image_url');
      t.boolean('shared_to_social').defaultTo(false);
      t.timestamp('shared_at');
    });
  }
};

exports.down = async function (knex) {
  try {
    await knex.schema.alterTable('blog_posts', t => {
      t.dropColumn('featured_image_url');
      t.dropColumn('shared_to_social');
      t.dropColumn('shared_at');
    });
  } catch { /* ignore */ }
};
