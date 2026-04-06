exports.up = async function (knex) {
  await knex.schema.alterTable('scheduled_services', t => {
    t.string('square_booking_id', 100);
    t.string('source', 30).defaultTo('admin'); // admin, square, calendar
    t.index('square_booking_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('scheduled_services', t => {
    t.dropColumn('square_booking_id');
    t.dropColumn('source');
  });
};
