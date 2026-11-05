/**
 * Basic payroll: the SIMPLE IRA at Schwab (owner 2026-11-04, B2 A; plan starts 1 Jan 2027).
 *
 * payroll_simple_ira_elections holds what an admin types from the signed SIMPLE IRA salary
 * reduction agreement: whether the employee takes part (Waves pays the 2% nonelective
 * contribution for every participant, never withheld from pay) and how much of each check the
 * employee saves, as a percent of gross pay (deferral_bp, 1/100 of a percent) OR a dollar amount
 * per check (deferral_cents), never both. Like payroll_w4_elections each row is evidence: a trigger
 * blocks UPDATE and DELETE, and a correction is a new row. The row a pay run uses is the one with
 * the latest effective_on not after the pay date (a later created_at wins a same-day tie).
 * A non-participant row (participant = false) carries no deferral and ends participation.
 *
 * payroll_checks gets three columns, all NULL on a check with no election in force (so every
 * existing check and every check made without an election is unchanged): the election row behind
 * the check, the employee's deferral and the employer 2% figure. They are all NULL or all set.
 * The existing protect_payroll_checks trigger compares whole rows, so a stored check stays frozen.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('payroll_simple_ira_elections', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.boolean('participant').notNullable();
    t.integer('deferral_bp').nullable();
    t.bigInteger('deferral_cents').nullable();
    t.date('signed_on').notNullable();
    t.date('effective_on').notNullable();
    t.uuid('entered_by').nullable().references('id').inTable('technicians');
    t.text('note').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX payroll_simple_ira_elections_tech_effective_idx ON payroll_simple_ira_elections (technician_id, effective_on DESC, created_at DESC)');
  await knex.raw(`ALTER TABLE payroll_simple_ira_elections
    ADD CONSTRAINT payroll_simple_ira_elections_deferral_bp_check CHECK (deferral_bp IS NULL OR (deferral_bp >= 0 AND deferral_bp <= 10000)),
    ADD CONSTRAINT payroll_simple_ira_elections_deferral_cents_check CHECK (deferral_cents IS NULL OR deferral_cents >= 0),
    ADD CONSTRAINT payroll_simple_ira_elections_one_form_check CHECK (deferral_bp IS NULL OR deferral_cents IS NULL),
    ADD CONSTRAINT payroll_simple_ira_elections_participant_check CHECK (participant OR (deferral_bp IS NULL AND deferral_cents IS NULL)),
    ADD CONSTRAINT payroll_simple_ira_elections_note_check CHECK (note IS NULL OR char_length(note) <= 500)`);

  await knex.raw(`CREATE FUNCTION protect_payroll_simple_ira_elections() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'SIMPLE IRA elections cannot be changed or deleted; enter a new row to correct one';
    END $$`);
  await knex.raw('CREATE TRIGGER protect_payroll_simple_ira_elections BEFORE UPDATE OR DELETE ON payroll_simple_ira_elections FOR EACH ROW EXECUTE FUNCTION protect_payroll_simple_ira_elections()');

  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN simple_election_id uuid NULL REFERENCES payroll_simple_ira_elections(id) ON DELETE RESTRICT,
    ADD COLUMN simple_deferral_cents bigint NULL,
    ADD COLUMN simple_employer_cents bigint NULL`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_simple_ira_check CHECK (
      (simple_election_id IS NULL) = (simple_deferral_cents IS NULL)
      AND (simple_election_id IS NULL) = (simple_employer_cents IS NULL)
      AND (simple_deferral_cents IS NULL OR simple_deferral_cents >= 0)
      AND (simple_employer_cents IS NULL OR simple_employer_cents >= 0))`);
};

exports.down = async function down(knex) {
  if (await knex('payroll_simple_ira_elections').first('id')) {
    throw new Error('payroll_simple_ira_elections holds SIMPLE IRA evidence. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT payroll_checks_simple_ira_check');
  await knex.raw(`ALTER TABLE payroll_checks
    DROP COLUMN simple_employer_cents,
    DROP COLUMN simple_deferral_cents,
    DROP COLUMN simple_election_id`);
  await knex.raw('DROP TRIGGER protect_payroll_simple_ira_elections ON payroll_simple_ira_elections');
  await knex.raw('DROP FUNCTION protect_payroll_simple_ira_elections()');
  await knex.schema.dropTable('payroll_simple_ira_elections');
};
