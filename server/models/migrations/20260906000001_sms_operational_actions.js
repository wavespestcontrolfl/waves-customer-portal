/** Extend the existing commitment ledger to SMS without exposing SMS work in call queues. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  if (!(await knex.schema.hasColumn('call_commitments', 'sms_log_id'))) {
    await knex.schema.alterTable('call_commitments', (t) => {
      t.uuid('call_log_id').nullable().alter();
      t.uuid('sms_log_id').references('id').inTable('sms_log').onDelete('CASCADE');
      t.jsonb('sms_context');
      t.unique(['sms_log_id', 'commitment_key']);
    });
    await knex.raw(`ALTER TABLE call_commitments ADD CONSTRAINT commitment_one_source
      CHECK ((call_log_id IS NOT NULL)::int + (sms_log_id IS NOT NULL)::int = 1)`);
  }
  if (!(await knex.schema.hasColumn('sms_log', 'operational_analysis'))) {
    await knex.schema.alterTable('sms_log', (t) => t.jsonb('operational_analysis'));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  // Preserve recorded SMS evidence. Rollback is safe only before activation;
  // deliberately refuse to discard a customer's outstanding obligations.
  if (await knex.schema.hasColumn('sms_log', 'operational_analysis')) {
    const analyzed = await knex('sms_log').whereNotNull('operational_analysis').first('id');
    if (analyzed) throw new Error('SMS analysis exists; disable the gate instead of dropping its evidence');
  }
  if (await knex.schema.hasColumn('call_commitments', 'sms_log_id')) {
    const recorded = await knex('call_commitments').whereNotNull('sms_log_id').first('id');
    if (recorded) throw new Error('SMS commitments exist; disable the gate instead of dropping their evidence');
    await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS commitment_one_source');
    await knex.schema.alterTable('call_commitments', (t) => {
      t.dropUnique(['sms_log_id', 'commitment_key']);
      t.dropColumn('sms_log_id');
      t.dropColumn('sms_context');
      t.uuid('call_log_id').notNullable().alter();
    });
  }
  if (await knex.schema.hasColumn('sms_log', 'operational_analysis')) {
    await knex.schema.alterTable('sms_log', (t) => t.dropColumn('operational_analysis'));
  }
};
