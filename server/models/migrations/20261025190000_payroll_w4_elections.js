/**
 * Basic payroll, layer 1b-2a (owner 2026-10-25, "can we start building basic
 * now, and add layers to it at later stages?"): the Form W-4 elections and how
 * each W-2 technician is paid. Dark behind GATE_PAYROLL; additive.
 *
 * payroll_w4_elections holds the numbers an admin types from the signed PAPER
 * W-4. The paper form stays the legal record (it carries the SSN and the
 * employee's signature; the employer keeps it 4 years). The portal stores no
 * SSN here and no bank account number anywhere. Each row is evidence: a
 * trigger blocks UPDATE and DELETE, and a correction is a new row. The row the
 * pay run uses is the one with the latest effective_on not after the pay date
 * (a later created_at wins a same-day tie).
 *
 * technicians.pay_method is 'check' (paper check) or 'bank_transfer'. Florida
 * law needs the employee's written OK before pay goes to a bank, so
 * bank_transfer needs pay_method_consent_on, the date that OK was received.
 * Only the method and that date are stored.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('payroll_w4_elections', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.integer('form_year').notNullable();
    t.text('filing_status').notNullable();
    t.boolean('step2_checkbox').notNullable().defaultTo(false);
    t.decimal('step3_amount', 12, 2).notNullable().defaultTo(0);
    t.decimal('step4a_other_income', 12, 2).notNullable().defaultTo(0);
    t.decimal('step4b_deductions', 12, 2).notNullable().defaultTo(0);
    t.decimal('step4c_extra_withholding', 12, 2).notNullable().defaultTo(0);
    t.boolean('exempt').notNullable().defaultTo(false);
    t.date('signed_on').notNullable();
    t.date('effective_on').notNullable();
    t.uuid('entered_by').nullable().references('id').inTable('technicians');
    t.text('note').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['technician_id', 'effective_on', 'created_at'], 'payroll_w4_elections_tech_effective_idx');
  });
  // knex cannot express desc index columns or CHECKs; replace the index and add the checks.
  await knex.raw('DROP INDEX payroll_w4_elections_tech_effective_idx');
  await knex.raw('CREATE INDEX payroll_w4_elections_tech_effective_idx ON payroll_w4_elections (technician_id, effective_on DESC, created_at DESC)');
  await knex.raw(`ALTER TABLE payroll_w4_elections
    ADD CONSTRAINT payroll_w4_elections_form_year_check CHECK (form_year >= 2020),
    ADD CONSTRAINT payroll_w4_elections_filing_status_check
      CHECK (filing_status IN ('single', 'married_separately', 'married_jointly', 'head_of_household')),
    ADD CONSTRAINT payroll_w4_elections_amounts_check
      CHECK (step3_amount >= 0 AND step4a_other_income >= 0 AND step4b_deductions >= 0 AND step4c_extra_withholding >= 0),
    ADD CONSTRAINT payroll_w4_elections_note_check CHECK (note IS NULL OR char_length(note) <= 500)`);

  await knex.raw(`CREATE FUNCTION protect_payroll_w4_elections() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'W-4 elections cannot be changed or deleted; enter a new row to correct one';
    END $$`);
  await knex.raw('CREATE TRIGGER protect_payroll_w4_elections BEFORE UPDATE OR DELETE ON payroll_w4_elections FOR EACH ROW EXECUTE FUNCTION protect_payroll_w4_elections()');

  await knex.schema.alterTable('technicians', (t) => {
    t.text('pay_method').notNullable().defaultTo('check');
    t.date('pay_method_consent_on').nullable();
  });
  await knex.raw(`ALTER TABLE technicians
    ADD CONSTRAINT technicians_pay_method_check CHECK (pay_method IN ('check', 'bank_transfer')),
    ADD CONSTRAINT technicians_pay_method_consent_check
      CHECK (pay_method <> 'bank_transfer' OR pay_method_consent_on IS NOT NULL)`);
};

exports.down = async function down(knex) {
  if (await knex('payroll_w4_elections').first('id')) {
    throw new Error('payroll_w4_elections holds W-4 evidence. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE technicians DROP CONSTRAINT technicians_pay_method_consent_check');
  await knex.raw('ALTER TABLE technicians DROP CONSTRAINT technicians_pay_method_check');
  await knex.schema.alterTable('technicians', (t) => {
    t.dropColumn('pay_method_consent_on');
    t.dropColumn('pay_method');
  });
  await knex.raw('DROP TRIGGER protect_payroll_w4_elections ON payroll_w4_elections');
  await knex.raw('DROP FUNCTION protect_payroll_w4_elections()');
  await knex.schema.dropTable('payroll_w4_elections');
};
