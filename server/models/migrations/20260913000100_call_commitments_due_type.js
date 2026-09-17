/**
 * Classify a spoken commitment's due_at at extraction time. Existing rows
 * remain NULL and are treated as floors by the promised-link delivery guard.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('call_commitments', 'due_type'))) {
    await knex.schema.alterTable('call_commitments', (t) => { t.string('due_type', 16).nullable(); });
  }
  await knex.raw(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'call_commitments_due_type_check'
          AND conrelid = 'call_commitments'::regclass
      ) THEN
        ALTER TABLE call_commitments
          ADD CONSTRAINT call_commitments_due_type_check
          CHECK (due_type IS NULL OR due_type IN ('floor', 'deadline'));
      END IF;
    END
  $$`);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS call_commitments_due_type_check');
  if (await knex.schema.hasColumn('call_commitments', 'due_type')) {
    await knex.schema.alterTable('call_commitments', (t) => { t.dropColumn('due_type'); });
  }
};
