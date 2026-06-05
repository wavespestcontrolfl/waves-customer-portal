exports.up = async function up(knex) {
  const hasRuns = await knex.schema.hasTable('route_optimization_planner_runs');
  if (!hasRuns) {
    await knex.schema.createTable('route_optimization_planner_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('run_type', 40).notNullable().defaultTo('bulk_apply');
      t.string('status', 40).notNullable().defaultTo('completed');
      t.date('start_date').notNullable();
      t.date('end_date').notNullable();
      t.jsonb('technician_ids').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('service_types').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('constraints').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('proposal_ids').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('result').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.integer('applied_count').notNullable().defaultTo(0);
      t.integer('skipped_count').notNullable().defaultTo(0);
      t.integer('failed_count').notNullable().defaultTo(0);
      t.uuid('created_by').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['run_type', 'created_at'], 'idx_route_planner_runs_type_created');
      t.index(['start_date', 'end_date'], 'idx_route_planner_runs_range');
    });
  }

  const hasProposals = await knex.schema.hasTable('route_optimization_proposals');
  if (!hasProposals) return;

  const addColumnIfMissing = async (column, add) => {
    const exists = await knex.schema.hasColumn('route_optimization_proposals', column);
    if (!exists) {
      await knex.schema.alterTable('route_optimization_proposals', add);
    }
  };

  await addColumnIfMissing('rollback_summary', (t) => {
    t.jsonb('rollback_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
  });
  await addColumnIfMissing('rolled_back_by', (t) => {
    t.uuid('rolled_back_by').nullable();
  });
  await addColumnIfMissing('rolled_back_at', (t) => {
    t.timestamp('rolled_back_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  const hasProposals = await knex.schema.hasTable('route_optimization_proposals');
  if (hasProposals) {
    await knex.schema.alterTable('route_optimization_proposals', (t) => {
      t.dropColumn('rolled_back_at');
      t.dropColumn('rolled_back_by');
      t.dropColumn('rollback_summary');
    });
  }

  await knex.schema.dropTableIfExists('route_optimization_planner_runs');
};
