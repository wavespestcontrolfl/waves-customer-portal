/**
 * Payroll pay rate steps (owner 2026-11-05: first technician starts at $23.00 an hour, then $25
 * automatically in the first full pay week after day 90).
 *
 * payroll_rate_steps holds a future hourly rate an admin typed, with the Monday it starts. A daily job
 * (and every pay run) applies a step that is due: it stores the rate in force as previous_rate, sets
 * technicians.pay_rate to hourly_rate and stamps applied_at. previous_rate is what lets a pay run for a
 * week BEFORE the step still pay the earlier rate when it is drafted after the step was applied.
 * A step that has not been applied can be cancelled (cancelled_at); an applied step cannot.
 *
 * With no rows in this table every pay run reads what it read before: no existing column changes.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('payroll_rate_steps', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.date('effective_on').notNullable();
    t.decimal('hourly_rate', 8, 2).notNullable();
    t.decimal('previous_rate', 8, 2).nullable();
    t.timestamp('applied_at', { useTz: true }).nullable();
    t.timestamp('cancelled_at', { useTz: true }).nullable();
    t.uuid('cancelled_by').nullable().references('id').inTable('technicians');
    t.text('note').nullable();
    t.uuid('created_by').notNullable().references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE UNIQUE INDEX payroll_rate_steps_open_day_idx ON payroll_rate_steps (technician_id, effective_on) WHERE cancelled_at IS NULL');
  await knex.raw('CREATE INDEX payroll_rate_steps_open_due_idx ON payroll_rate_steps (effective_on) WHERE applied_at IS NULL AND cancelled_at IS NULL');
  await knex.raw(`ALTER TABLE payroll_rate_steps
    ADD CONSTRAINT payroll_rate_steps_rate_check CHECK (hourly_rate > 0 AND (previous_rate IS NULL OR previous_rate >= 0)),
    ADD CONSTRAINT payroll_rate_steps_monday_check CHECK (EXTRACT(ISODOW FROM effective_on) = 1),
    ADD CONSTRAINT payroll_rate_steps_not_both_check CHECK (applied_at IS NULL OR cancelled_at IS NULL),
    ADD CONSTRAINT payroll_rate_steps_cancelled_by_check CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
    ADD CONSTRAINT payroll_rate_steps_note_check CHECK (note IS NULL OR char_length(note) <= 500)`);
};

exports.down = async function down(knex) {
  if (await knex('payroll_rate_steps').whereNotNull('applied_at').first('id')) {
    throw new Error('payroll_rate_steps holds applied steps, whose previous_rate prices earlier pay weeks. Preserve the schema and roll forward.');
  }
  await knex.schema.dropTable('payroll_rate_steps');
};
