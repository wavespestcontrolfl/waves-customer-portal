exports.up = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.timestamp('scheduled_at').nullable();
    t.string('send_method').nullable(); // 'sms', 'email', 'both'
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('scheduled_at');
    t.dropColumn('send_method');
  });
};
