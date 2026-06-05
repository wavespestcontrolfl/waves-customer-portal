exports.up = async function up(knex) {
  const hasProposals = await knex.schema.hasTable('route_optimization_proposals');
  if (!hasProposals) {
    await knex.schema.createTable('route_optimization_proposals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('scheduled_date').notNullable();
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.string('scope', 40).notNullable().defaultTo('single_day');
      t.string('status', 24).notNullable().defaultTo('draft');
      t.string('source', 64).notNullable().defaultTo('manual');
      t.string('optimizer_source', 64).nullable();
      t.uuid('parent_proposal_id').nullable().references('id').inTable('route_optimization_proposals').onDelete('SET NULL');
      t.string('regeneration_reason', 120).nullable();
      t.integer('service_count').notNullable().defaultTo(0);
      t.integer('tech_count').notNullable().defaultTo(0);
      t.integer('total_distance_meters').notNullable().defaultTo(0);
      t.integer('unoptimized_distance_meters').notNullable().defaultTo(0);
      t.integer('saved_distance_meters').notNullable().defaultTo(0);
      t.integer('total_duration_minutes').notNullable().defaultTo(0);
      t.jsonb('constraints').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('warnings').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('override_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('comparison_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('commit_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('before_snapshot').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('after_snapshot').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.uuid('created_by').nullable();
      t.uuid('committed_by').nullable();
      t.timestamp('committed_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['scheduled_date', 'status'], 'idx_route_opt_proposals_date_status');
      t.index(['technician_id', 'scheduled_date'], 'idx_route_opt_proposals_tech_date');
      t.index(['parent_proposal_id'], 'idx_route_opt_proposals_parent');
    });
  }

  const hasItems = await knex.schema.hasTable('route_optimization_proposal_items');
  if (!hasItems) {
    await knex.schema.createTable('route_optimization_proposal_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('proposal_id').notNullable().references('id').inTable('route_optimization_proposals').onDelete('CASCADE');
      t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('current_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('proposed_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.integer('current_route_order').nullable();
      t.integer('proposed_route_order').notNullable();
      t.integer('current_position').nullable();
      t.integer('proposed_position').notNullable();
      t.integer('distance_from_previous_meters').nullable();
      t.integer('duration_from_previous_minutes').nullable();
      t.jsonb('before_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('after_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('warnings').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.unique(['proposal_id', 'scheduled_service_id'], 'uq_route_opt_item_proposal_service');
      t.index(['proposal_id', 'proposed_position'], 'idx_route_opt_items_proposal_position');
      t.index(['scheduled_service_id'], 'idx_route_opt_items_service');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('route_optimization_proposal_items');
  await knex.schema.dropTableIfExists('route_optimization_proposals');
};
