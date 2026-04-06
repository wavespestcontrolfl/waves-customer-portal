exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.integer('health_score');
    t.string('health_risk', 20);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('health_score');
    t.dropColumn('health_risk');
  });
};
