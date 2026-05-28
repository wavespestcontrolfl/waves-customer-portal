exports.up = async function up(knex) {
  const hasBriefs = await knex.schema.hasTable('content_briefs');
  if (!hasBriefs) return;

  const hasFactsPack = await knex.schema.hasColumn('content_briefs', 'facts_pack');
  if (!hasFactsPack) {
    await knex.schema.alterTable('content_briefs', (t) => {
      t.jsonb('facts_pack');
    });
  }
};

exports.down = async function down(knex) {
  const hasBriefs = await knex.schema.hasTable('content_briefs');
  if (!hasBriefs) return;

  const hasFactsPack = await knex.schema.hasColumn('content_briefs', 'facts_pack');
  if (hasFactsPack) {
    await knex.schema.alterTable('content_briefs', (t) => {
      t.dropColumn('facts_pack');
    });
  }
};
