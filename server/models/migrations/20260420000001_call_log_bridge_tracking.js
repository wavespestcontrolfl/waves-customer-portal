exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('call_log', 'bridged_at'))) {
    await knex.schema.alterTable('call_log', t => {
      t.timestamp('bridged_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('call_log', 'source'))) {
    await knex.schema.alterTable('call_log', t => {
      t.string('source', 50).nullable();
      t.index('source');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('call_log', 'source')) {
    await knex.schema.alterTable('call_log', t => {
      t.dropColumn('source');
    });
  }
  if (await knex.schema.hasColumn('call_log', 'bridged_at')) {
    await knex.schema.alterTable('call_log', t => {
      t.dropColumn('bridged_at');
    });
  }
};
