exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('field_service_evidence'))) return;
  await knex.raw(`CREATE OR REPLACE FUNCTION field_program_check_claim_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE capacity integer;
    BEGIN
      IF NEW.allocation_id IS NOT NULL THEN
        SELECT planned_visits INTO capacity FROM field_credit_allocations WHERE id = NEW.allocation_id FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Allocation is not available' USING ERRCODE = '23503';
        END IF;
        IF NEW.ordinal > capacity THEN
          RAISE EXCEPTION 'Application ordinal exceeds the retained scheduled count'
            USING ERRCODE = '23514', CONSTRAINT = 'field_service_claim_capacity';
        END IF;
      END IF;
      RETURN NEW;
    END;
  $$`);
  await knex.raw('DROP TRIGGER IF EXISTS field_service_claim_capacity ON field_service_evidence');
  await knex.raw('CREATE TRIGGER field_service_claim_capacity BEFORE INSERT ON field_service_evidence FOR EACH ROW EXECUTE FUNCTION field_program_check_claim_capacity()');
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('field_service_evidence')) await knex.raw('DROP TRIGGER IF EXISTS field_service_claim_capacity ON field_service_evidence');
  await knex.raw('DROP FUNCTION IF EXISTS field_program_check_claim_capacity()');
};
