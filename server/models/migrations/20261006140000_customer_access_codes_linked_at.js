/**
 * Access codes: when the office linked a code from a text with no customer.
 * Such a text stays without a customer, and its linked rows belong to the
 * customer the office chose. A text that LOSES its customer later is a
 * different case: rows filed for the old customer stop being theirs. This
 * column tells the two apart (NULL = not linked by the office).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('customer_access_codes', 'linked_at'))) {
    await knex.schema.alterTable('customer_access_codes', (t) => { t.timestamp('linked_at', { useTz: true }).nullable(); });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('customer_access_codes', 'linked_at')) {
    await knex.schema.alterTable('customer_access_codes', (t) => { t.dropColumn('linked_at'); });
  }
};
