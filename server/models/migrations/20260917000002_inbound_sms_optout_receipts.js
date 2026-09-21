exports.up = async function (knex) {
  await knex.schema.createTable('inbound_sms_optout_receipts', (t) => {
    t.text('message_sid').primary();
    t.text('phone').notNullable();
    t.timestamp('applied_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('inbound_sms_optout_receipts');
};
