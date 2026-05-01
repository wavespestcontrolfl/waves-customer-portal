/**
 * Customer intake: last name is preferred, service address is optional.
 *
 * Phone-booked appointments can happen before the office has a service address.
 * Keep first_name and phone required; allow last_name/address fields to be filled later.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('last_name', 50).nullable().alter();
    t.string('address_line1', 200).nullable().alter();
    t.string('city', 50).nullable().alter();
    t.string('zip', 10).nullable().alter();
  });
};

exports.down = async function (knex) {
  await knex('customers').whereNull('last_name').update({ last_name: '' });
  await knex('customers').whereNull('address_line1').update({ address_line1: '' });
  await knex('customers').whereNull('city').update({ city: '' });
  await knex('customers').whereNull('zip').update({ zip: '' });

  await knex.schema.alterTable('customers', (t) => {
    t.string('last_name', 50).notNullable().alter();
    t.string('address_line1', 200).notNullable().alter();
    t.string('city', 50).notNullable().alter();
    t.string('zip', 10).notNullable().alter();
  });
};
