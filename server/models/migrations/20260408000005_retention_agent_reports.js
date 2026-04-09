exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('retention_agent_reports');
  if (exists) return;

  await knex.schema.createTable('retention_agent_reports', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.text('summary');
    t.integer('customers_analyzed').defaultTo(0);
    t.integer('critical_count').defaultTo(0);
    t.integer('at_risk_count').defaultTo(0);
    t.integer('calls_scheduled').defaultTo(0);
    t.integer('sms_sent').defaultTo(0);
    t.integer('sequences_enrolled').defaultTo(0);
    t.integer('upsells_identified').defaultTo(0);
    t.decimal('revenue_at_risk', 10, 2).defaultTo(0);
    t.decimal('estimated_revenue_saved', 10, 2).defaultTo(0);
    t.decimal('upsell_pipeline_value', 10, 2).defaultTo(0);
    t.text('top_priorities');
    t.text('action_items');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('created_at');
  });

  // Add pitch_message and pitched_at to upsell_opportunities if missing
  if (await knex.schema.hasTable('upsell_opportunities')) {
    if (!(await knex.schema.hasColumn('upsell_opportunities', 'pitch_message'))) {
      await knex.schema.alterTable('upsell_opportunities', (t) => { t.text('pitch_message'); });
    }
    if (!(await knex.schema.hasColumn('upsell_opportunities', 'pitched_at'))) {
      await knex.schema.alterTable('upsell_opportunities', (t) => { t.timestamp('pitched_at'); });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('retention_agent_reports');
};
