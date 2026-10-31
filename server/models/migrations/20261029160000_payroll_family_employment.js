/**
 * Payroll family employee (owner ruling 2026-10-29, D5 part 2 of the first-technician
 * pay plan: "Build the payroll pieces now, switched off"). Dark behind
 * GATE_PAYROLL_FAMILY_EMPLOYEE; additive.
 *
 * technicians: family_relationship / family_employer_entity / family_exempt_from record
 * that a W-2 employee is the owner's parent or spouse, which entity employs them (a sole
 * proprietorship or a single-member LLC with no S election; an S election or a partner
 * ends the exception) and the date from which their pay is exempt from federal
 * unemployment tax (26 U.S.C. 3306(c)(5)) and Florida reemployment tax
 * (F.S. 443.1216(13)(d)). All three are set or all three are empty.
 *
 * payroll_checks: unemployment_exempt / unemployment_wages_cents are null on every
 * existing row and on any check drafted with the gate off. A check drafted with it on
 * stores whether it was exempt and the FUTA and RT-6 wages it counted (its share of the
 * $7,000 base; 0 when exempt). protect_payroll_checks compares whole rows with to_jsonb,
 * so a finalized check cannot change them either; that trigger is not touched.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE technicians
    ADD COLUMN family_relationship text NULL,
    ADD COLUMN family_employer_entity text NULL,
    ADD COLUMN family_exempt_from date NULL`);
  await knex.raw(`ALTER TABLE technicians
    ADD CONSTRAINT technicians_family_relationship_check CHECK (family_relationship IS NULL OR family_relationship IN ('parent', 'spouse')),
    ADD CONSTRAINT technicians_family_entity_check CHECK (family_employer_entity IS NULL OR family_employer_entity IN ('sole_proprietorship', 'single_member_llc')),
    ADD CONSTRAINT technicians_family_all_or_none_check CHECK (
      (family_relationship IS NULL AND family_employer_entity IS NULL AND family_exempt_from IS NULL)
      OR (family_relationship IS NOT NULL AND family_employer_entity IS NOT NULL AND family_exempt_from IS NOT NULL))`);

  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN unemployment_exempt boolean NULL,
    ADD COLUMN unemployment_wages_cents bigint NULL`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_unemployment_pair_check CHECK ((unemployment_exempt IS NULL) = (unemployment_wages_cents IS NULL)),
    ADD CONSTRAINT payroll_checks_unemployment_wages_check CHECK (unemployment_wages_cents IS NULL OR unemployment_wages_cents >= 0),
    ADD CONSTRAINT payroll_checks_unemployment_exempt_check CHECK (
      unemployment_exempt IS NOT TRUE
      OR (unemployment_wages_cents = 0 AND futa_cents = 0 AND fl_reemployment_cents = 0))`);
};

exports.down = async function down(knex) {
  // A stored exemption or a family setting is payroll evidence: preserve it and roll forward.
  if (await knex.schema.hasColumn('payroll_checks', 'unemployment_exempt')
    && await knex('payroll_checks').whereNotNull('unemployment_exempt').first('id')) {
    throw new Error('payroll_checks holds unemployment exemption figures. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('technicians', 'family_relationship')
    && await knex('technicians').whereNotNull('family_relationship').first('id')) {
    throw new Error('technicians holds a family employee setting. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw(`ALTER TABLE payroll_checks
    DROP CONSTRAINT IF EXISTS payroll_checks_unemployment_exempt_check,
    DROP CONSTRAINT IF EXISTS payroll_checks_unemployment_wages_check,
    DROP CONSTRAINT IF EXISTS payroll_checks_unemployment_pair_check`);
  await knex.raw(`ALTER TABLE payroll_checks
    DROP COLUMN IF EXISTS unemployment_wages_cents,
    DROP COLUMN IF EXISTS unemployment_exempt`);
  await knex.raw(`ALTER TABLE technicians
    DROP CONSTRAINT IF EXISTS technicians_family_all_or_none_check,
    DROP CONSTRAINT IF EXISTS technicians_family_entity_check,
    DROP CONSTRAINT IF EXISTS technicians_family_relationship_check`);
  await knex.raw(`ALTER TABLE technicians
    DROP COLUMN IF EXISTS family_exempt_from,
    DROP COLUMN IF EXISTS family_employer_entity,
    DROP COLUMN IF EXISTS family_relationship`);
};
