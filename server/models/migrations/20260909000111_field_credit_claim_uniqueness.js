// Reinforce the allocation/claim invariants for every writer, including null
// property scopes. Existing history and the original migration stay unchanged.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('field_credit_allocations')) {
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS field_allocations_no_property_unique
      ON field_credit_allocations (customer_id, service_key, coverage_start, coverage_end)
      WHERE property_id IS NULL`);
  }
  if (await knex.schema.hasTable('field_service_evidence')) {
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS field_service_one_allocation_claim
      ON field_service_evidence (service_id) WHERE claims_allocation = true`);
  }
};
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS field_service_one_allocation_claim');
  await knex.raw('DROP INDEX IF EXISTS field_allocations_no_property_unique');
};
