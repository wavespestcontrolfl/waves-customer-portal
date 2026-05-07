/**
 * Estimate pricing audit snapshots.
 *
 * Current pricing audits intentionally recalculate from today's inventory COGS
 * and protocol mappings. This table preserves what the audit looked like when
 * an estimate was actually sent so older quotes can be reviewed against their
 * original cost/margin context.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('estimate_pricing_audit_snapshots');
  if (exists) return;

  await knex.schema.createTable('estimate_pricing_audit_snapshots', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.timestamp('snapshot_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('trigger', 40).notNullable().defaultTo('send');
    t.string('send_method', 20);
    t.string('pricing_version', 80);
    t.decimal('revenue', 10, 2);
    t.decimal('estimated_cost', 10, 2);
    t.decimal('gross_profit', 10, 2);
    t.decimal('margin', 8, 4);
    t.jsonb('audit').notNullable();
    t.timestamps(true, true);

    t.index(['estimate_id', 'snapshot_at'], 'idx_estimate_pricing_snapshots_estimate_time');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('estimate_pricing_audit_snapshots');
};
