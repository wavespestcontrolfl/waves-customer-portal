exports.up = async function(knex) {
  if (!(await knex.schema.hasColumn('call_log', 'lead_synopsis'))) {
    await knex.schema.alterTable('call_log', t => {
      t.text('lead_synopsis').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('leads', 'lead_synopsis'))) {
    await knex.schema.alterTable('leads', t => {
      t.text('lead_synopsis').nullable();
    });
  }
};

exports.down = async function(knex) {
  if (await knex.schema.hasColumn('call_log', 'lead_synopsis')) {
    await knex.schema.alterTable('call_log', t => {
      t.dropColumn('lead_synopsis');
    });
  }
  if (await knex.schema.hasColumn('leads', 'lead_synopsis')) {
    await knex.schema.alterTable('leads', t => {
      t.dropColumn('lead_synopsis');
    });
  }
};
