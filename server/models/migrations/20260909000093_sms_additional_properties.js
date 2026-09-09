exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE triage_items ALTER COLUMN call_log_id DROP NOT NULL');
  if (!(await knex.schema.hasColumn('triage_items', 'sms_log_id'))) {
    await knex.schema.alterTable('triage_items', (t) => {
      t.uuid('sms_log_id').nullable().references('id').inTable('sms_log').onDelete('CASCADE');
    });
  }
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS triage_items_sms_reason_unique ON triage_items (sms_log_id, reason_code) WHERE sms_log_id IS NOT NULL');
};
exports.down = async function down() {}; // Gate rollback preserves office decisions.
