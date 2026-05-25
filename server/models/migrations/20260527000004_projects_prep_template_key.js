exports.up = async function up(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.string('prep_template_key', 64).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('prep_template_key');
  });
};
