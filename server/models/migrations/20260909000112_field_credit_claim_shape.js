exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('field_service_evidence'))) return;
  await knex.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'field_service_claim_allocation_shape' AND conrelid = 'field_service_evidence'::regclass) THEN
      ALTER TABLE field_service_evidence ADD CONSTRAINT field_service_claim_allocation_shape CHECK (
        (allocation_id IS NULL AND ordinal IS NULL AND claims_allocation = false) OR
        (allocation_id IS NOT NULL AND ordinal IS NOT NULL AND ordinal > 0)
      );
    END IF;
  END $$`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('field_service_evidence'))) return;
  await knex.raw('ALTER TABLE field_service_evidence DROP CONSTRAINT IF EXISTS field_service_claim_allocation_shape');
};
