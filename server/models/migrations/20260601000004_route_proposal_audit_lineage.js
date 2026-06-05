exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('route_optimization_proposals');
  if (!hasTable) return;

  const addColumnIfMissing = async (column, add) => {
    const exists = await knex.schema.hasColumn('route_optimization_proposals', column);
    if (!exists) {
      await knex.schema.alterTable('route_optimization_proposals', add);
    }
  };

  await addColumnIfMissing('parent_proposal_id', (t) => {
    t.uuid('parent_proposal_id').nullable().references('id').inTable('route_optimization_proposals').onDelete('SET NULL');
  });
  await addColumnIfMissing('regeneration_reason', (t) => {
    t.string('regeneration_reason', 120).nullable();
  });
  await addColumnIfMissing('override_summary', (t) => {
    t.jsonb('override_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
  });
  await addColumnIfMissing('comparison_summary', (t) => {
    t.jsonb('comparison_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
  });
  await addColumnIfMissing('commit_summary', (t) => {
    t.jsonb('commit_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
  });

  const hasParentIndex = await knex.schema.hasTable('route_optimization_proposals');
  if (hasParentIndex) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_route_opt_proposals_parent
      ON route_optimization_proposals(parent_proposal_id)
    `);
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('route_optimization_proposals');
  if (!hasTable) return;

  // The restored base route-optimization migration owns these lineage and
  // summary columns. This migration only adds them for older partial schemas,
  // so targeted rollback must not remove current proposal history fields.
};
