// Multi-home family link, PR 1 (owner 2026-11-04): staff can mark two or more
// customer profiles as "Same family" so the 10% Multi-Home Discount applies to
// every home in the group, even when each home is its own profile (for
// example a parent's home and a son's home billed to a Bill-To payer).
//
//   multi_home_family_members  one row per linked profile. Rows that share a
//                              family_id are one family. A profile is in at
//                              most one family (customer_id is UNIQUE).
//
// This table is separate on purpose: customers.has_multi_home keeps meaning
// "this ONE profile has 2+ premises" for the access-code picker, the reservice
// scope and the lawn sheets. Only the discount eligibility readers look here.
//
// No data is written here; the table starts empty.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('multi_home_family_members')) return;
  await knex.schema.createTable('multi_home_family_members', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().unique().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('family_id').notNullable();
    t.uuid('linked_by').nullable();
    t.timestamp('linked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['family_id'], 'multi_home_family_members_family_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('multi_home_family_members');
};
