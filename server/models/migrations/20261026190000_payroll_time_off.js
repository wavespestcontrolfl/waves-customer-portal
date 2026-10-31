/**
 * Payroll time off (owner ruling 2026-10-26: "Paid days off. The portal's
 * payroll cannot pay time off or holidays. Fix: add this before the tech's
 * first day off."). Dark behind GATE_PAYROLL_TIME_OFF; additive.
 *
 * payroll_time_off: one row per W-2 technician per calendar day that is paid but
 * not worked (kind 'pto' or 'holiday'). minutes is the paid length of that day
 * (up to 24 hours). The benefits policy is not final, so no allowance or holiday
 * list lives in code; every number is a setting or an entry.
 *
 * payroll_checks: four new columns snapshot the time-off minutes and pay on a
 * check, like regular_minutes and the pay columns. A constant default rewrites
 * no row and fires no trigger. protect_payroll_checks compares whole rows with
 * to_jsonb, so a finalized check cannot change the new columns either; the
 * trigger is not touched.
 *
 * technicians.pto_hours_per_year: the yearly allowance, a setting. NULL = none
 * set. It only warns; it never blocks an entry.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('payroll_time_off', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.date('work_date').notNullable();
    t.text('kind').notNullable();
    t.decimal('minutes', 10, 2).notNullable();
    t.text('note').nullable();
    t.uuid('created_by').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by').nullable();
    t.timestamp('updated_at', { useTz: true }).nullable();
    t.unique(['technician_id', 'work_date'], { indexName: 'payroll_time_off_tech_date_unique' });
    t.index(['work_date'], 'payroll_time_off_work_date_idx');
  });
  await knex.raw(`ALTER TABLE payroll_time_off
    ADD CONSTRAINT payroll_time_off_kind_check CHECK (kind IN ('pto', 'holiday')),
    ADD CONSTRAINT payroll_time_off_minutes_check CHECK (minutes > 0 AND minutes <= 1440),
    ADD CONSTRAINT payroll_time_off_note_check CHECK (note IS NULL OR char_length(note) <= 500)`);

  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN pto_minutes numeric(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN holiday_minutes numeric(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN pto_pay_cents bigint NOT NULL DEFAULT 0,
    ADD COLUMN holiday_pay_cents bigint NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_time_off_check CHECK (
      pto_minutes >= 0 AND holiday_minutes >= 0 AND pto_pay_cents >= 0 AND holiday_pay_cents >= 0)`);

  await knex.raw(`ALTER TABLE technicians
    ADD COLUMN pto_hours_per_year numeric(6,2) NULL
      CONSTRAINT technicians_pto_hours_per_year_check
      CHECK (pto_hours_per_year IS NULL OR (pto_hours_per_year >= 0 AND pto_hours_per_year <= 400))`);
};

exports.down = async function down(knex) {
  // Time off already entered or paid is payroll evidence: preserve it and roll forward.
  if (await knex.schema.hasTable('payroll_time_off') && await knex('payroll_time_off').first('id')) {
    throw new Error('payroll_time_off holds entries. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('payroll_checks', 'pto_minutes')
    && await knex('payroll_checks')
      .whereRaw('pto_minutes > 0 OR holiday_minutes > 0 OR pto_pay_cents > 0 OR holiday_pay_cents > 0')
      .first('id')) {
    throw new Error('payroll_checks holds paid time off. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE technicians DROP COLUMN IF EXISTS pto_hours_per_year');
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_time_off_check');
  await knex.raw(`ALTER TABLE payroll_checks
    DROP COLUMN IF EXISTS holiday_pay_cents,
    DROP COLUMN IF EXISTS pto_pay_cents,
    DROP COLUMN IF EXISTS holiday_minutes,
    DROP COLUMN IF EXISTS pto_minutes`);
  await knex.schema.dropTableIfExists('payroll_time_off');
};
