exports.up = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (!cols.disposition) t.string('disposition', 50);
  });
};

exports.down = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (cols.disposition) t.dropColumn('disposition');
  });
};
