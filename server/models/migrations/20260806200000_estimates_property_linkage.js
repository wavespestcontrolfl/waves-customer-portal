/**
 * estimates property linkage — Phase 2 (estimates) of the multi-property
 * model (docs/multi-property-model.md). Lets one quote conversation cover
 * several service addresses ("landlord calls about their home + rental")
 * without restructuring the one-estimate-one-property document:
 *
 *  - `property_id` — FK to customer_properties when the quoted address
 *    resolves to a known property (nullable; SET NULL on property deletion
 *    so a property cleanup never cascades into estimate history). The
 *    free-text `estimates.address` snapshot stays authoritative for what
 *    was quoted — this only links it to the relational property row.
 *  - `estimate_group_id` — shared uuid linking sibling estimates drafted
 *    together for the same customer (one per property). Grouped estimates
 *    send as one message and render as one multi-property view; each is
 *    still priced, accepted, and converted independently.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (!(await knex.schema.hasColumn('estimates', 'property_id'))) {
    await knex.schema.alterTable('estimates', (t) => {
      t.uuid('property_id').references('id').inTable('customer_properties').onDelete('SET NULL');
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_estimates_property_id ON estimates (property_id) WHERE property_id IS NOT NULL');
  }
  if (!(await knex.schema.hasColumn('estimates', 'estimate_group_id'))) {
    await knex.schema.alterTable('estimates', (t) => {
      t.uuid('estimate_group_id');
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_estimates_estimate_group_id ON estimates (estimate_group_id) WHERE estimate_group_id IS NOT NULL');
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_estimates_estimate_group_id');
  await knex.raw('DROP INDEX IF EXISTS idx_estimates_property_id');
  if (await knex.schema.hasColumn('estimates', 'estimate_group_id')) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropColumn('estimate_group_id');
    });
  }
  if (await knex.schema.hasColumn('estimates', 'property_id')) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropColumn('property_id');
    });
  }
};
