// Simulation records only. No compensation terms, payroll lines, or payment
// transitions are introduced. History is append-only, including corrections.
const tables = [
  'field_program_rules', 'field_program_levels', 'field_credit_allocations',
  'field_service_evidence', 'field_production_simulations', 'field_business_evidence',
  'field_promotion_assessments', 'field_simulation_statements',
];

function identity(t, knex) {
  t.uuid('id').primary();
  t.uuid('created_by').notNullable().references('id').inTable('technicians');
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.string('input_hash', 64).notNullable();
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('field_program_rules'))) {
    await knex.schema.createTable('field_program_rules', t => {
      identity(t, knex);
      t.string('label', 100).notNullable();
      t.date('effective_date').notNullable().unique();
      t.jsonb('definition').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('field_program_levels'))) {
    await knex.schema.createTable('field_program_levels', t => {
      identity(t, knex);
      t.uuid('technician_id').notNullable().references('id').inTable('technicians');
      t.string('role_key', 30).notNullable();
      t.date('effective_date').notNullable();
      t.unique(['technician_id', 'effective_date']);
      t.check("role_key IN ('trainee', 'technician_i', 'technician_ii', 'service_manager', 'general_manager')");
    });
  }
  if (!(await knex.schema.hasTable('field_credit_allocations'))) {
    await knex.schema.createTable('field_credit_allocations', t => {
      identity(t, knex);
      t.uuid('customer_id').notNullable().references('id').inTable('customers');
      t.uuid('property_id').references('id').inTable('customer_properties');
      t.string('service_key', 150).notNullable();
      t.date('coverage_start').notNullable();
      t.date('coverage_end').notNullable();
      t.string('credit_type', 20).notNullable();
      t.integer('net_value_cents').notNullable();
      t.integer('planned_visits').notNullable();
      t.text('source_reference').notNullable();
      t.unique(['customer_id', 'property_id', 'service_key', 'coverage_start', 'coverage_end']);
      t.check('coverage_end >= coverage_start');
      t.check('net_value_cents >= 0 AND planned_visits BETWEEN 1 AND 366');
      t.check("credit_type IN ('routine', 'specialty')");
    });
  }
  if (!(await knex.schema.hasTable('field_service_evidence'))) {
    await knex.schema.createTable('field_service_evidence', t => {
      identity(t, knex);
      t.uuid('service_id').notNullable().references('id').inTable('scheduled_services');
      t.uuid('technician_id').notNullable().references('id').inTable('technicians');
      t.uuid('base_id').unique().references('id').inTable('field_service_evidence');
      t.integer('revision').notNullable();
      t.date('service_date').notNullable();
      t.string('service_key', 150);
      t.string('service_label', 150).notNullable();
      t.uuid('allocation_id').references('id').inTable('field_credit_allocations');
      t.integer('ordinal');
      t.boolean('claims_allocation').notNullable();
      t.jsonb('facts').notNullable();
      t.unique(['service_id', 'revision']);
      t.index(['technician_id', 'service_date']);
      t.check('(allocation_id IS NULL AND ordinal IS NULL) OR (allocation_id IS NOT NULL AND ordinal > 0)');
    });
    // Initial allocation claims are permanent; reviewing outcome evidence
    // never frees the original ordinal for another visit or redivides value.
    await knex.raw('CREATE UNIQUE INDEX field_credit_ordinal_once ON field_service_evidence (allocation_id, ordinal) WHERE claims_allocation = true');
  }
  if (!(await knex.schema.hasTable('field_production_simulations'))) {
    await knex.schema.createTable('field_production_simulations', t => {
      t.uuid('id').primary();
      t.uuid('evidence_id').notNullable().references('id').inTable('field_service_evidence');
      t.uuid('technician_id').notNullable().references('id').inTable('technicians');
      t.uuid('rule_id').references('id').inTable('field_program_rules');
      t.uuid('level_id').references('id').inTable('field_program_levels');
      t.jsonb('calculation').notNullable();
      t.unique(['evidence_id', 'technician_id']);
      t.index('technician_id');
    });
  }
  if (!(await knex.schema.hasTable('field_business_evidence'))) {
    await knex.schema.createTable('field_business_evidence', t => {
      identity(t, knex);
      t.uuid('estimate_id').notNullable().references('id').inTable('estimates');
      t.uuid('technician_id').notNullable().references('id').inTable('technicians');
      t.uuid('base_id').unique().references('id').inTable('field_business_evidence');
      t.integer('revision').notNullable();
      t.date('accepted_date').notNullable();
      t.uuid('rule_id').references('id').inTable('field_program_rules');
      t.jsonb('facts').notNullable();
      t.unique(['estimate_id', 'revision']);
      t.index(['technician_id', 'accepted_date']);
    });
  }
  if (!(await knex.schema.hasTable('field_promotion_assessments'))) {
    await knex.schema.createTable('field_promotion_assessments', t => {
      identity(t, knex);
      t.uuid('technician_id').notNullable().references('id').inTable('technicians');
      t.uuid('previous_id').unique().references('id').inTable('field_promotion_assessments');
      t.date('assessed_date').notNullable();
      t.string('from_role', 30).notNullable();
      t.string('to_role', 30).notNullable();
      t.string('rubric_version', 100).notNullable();
      t.jsonb('assessment').notNullable();
      t.jsonb('result').notNullable();
      t.index(['technician_id', 'assessed_date']);
    });
  }
  if (!(await knex.schema.hasTable('field_simulation_statements'))) {
    await knex.schema.createTable('field_simulation_statements', t => {
      identity(t, knex);
      t.uuid('technician_id').notNullable().references('id').inTable('technicians');
      t.string('month', 7).notNullable();
      t.jsonb('statement').notNullable();
      t.unique(['technician_id', 'month', 'input_hash']);
      t.index(['technician_id', 'month', 'created_at']);
    });
  }
  await knex.raw(`CREATE OR REPLACE FUNCTION field_program_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Field program history is immutable; append a linked revision' USING ERRCODE = '23514'; END;
  $$`);
  for (const table of tables) {
    await knex.raw('DROP TRIGGER IF EXISTS field_program_immutable ON ??', [table]);
    await knex.raw('CREATE TRIGGER field_program_immutable BEFORE UPDATE OR DELETE ON ?? FOR EACH ROW EXECUTE FUNCTION field_program_reject_mutation()', [table]);
  }
};

exports.down = async function down(knex) {
  for (const table of [...tables].reverse()) await knex.schema.dropTableIfExists(table);
  await knex.raw('DROP FUNCTION IF EXISTS field_program_reject_mutation()');
};
