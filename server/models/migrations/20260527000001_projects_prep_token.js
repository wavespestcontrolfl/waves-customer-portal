exports.up = async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.string('prep_token', 32).unique().nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('prep_token');
  });
};
