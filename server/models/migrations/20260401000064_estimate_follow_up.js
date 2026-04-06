exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', t => {
    t.integer('follow_up_count').defaultTo(0);
    t.timestamp('last_follow_up_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', t => {
    t.dropColumn('follow_up_count');
    t.dropColumn('last_follow_up_at');
  });
};
