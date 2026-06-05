exports.up = async function up(knex) {
  const hasItems = await knex.schema.hasTable('route_optimization_proposal_items');
  if (!hasItems) return;

  const hasCurrent = await knex.schema.hasColumn('route_optimization_proposal_items', 'current_technician_id');
  const hasProposed = await knex.schema.hasColumn('route_optimization_proposal_items', 'proposed_technician_id');
  if (!hasCurrent || !hasProposed) {
    await knex.schema.alterTable('route_optimization_proposal_items', (t) => {
      if (!hasCurrent) t.uuid('current_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      if (!hasProposed) t.uuid('proposed_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    });
  }

  await knex.raw(`
    UPDATE route_optimization_proposal_items
    SET current_technician_id = COALESCE(current_technician_id, technician_id),
        proposed_technician_id = COALESCE(proposed_technician_id, technician_id)
  `);
};

exports.down = async function down(knex) {
  const hasItems = await knex.schema.hasTable('route_optimization_proposal_items');
  if (!hasItems) return;

  // The restored base route-optimization migration owns these columns.
  // This migration only backfills them when present, so rollback must not
  // drop route reassignment data from an otherwise-current schema.
};
