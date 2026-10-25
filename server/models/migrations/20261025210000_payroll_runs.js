/**
 * Basic payroll, layer 1b-2b (owner 2026-10-25, "can we start building basic
 * now, and add layers to it at later stages?"): weekly pay runs, the paycheck
 * the portal works out for each W-2 technician, and the data for the pay stub.
 * Dark behind GATE_PAYROLL; additive.
 *
 * The portal prepares the numbers. The owner pays the technician (paper check,
 * or bank transfer with the employee's written OK) and makes every tax deposit
 * and filing himself. Nothing here moves money or sends a message.
 *
 * payroll_runs: one run per staff week (Monday-Sunday). draft -> finalized ->
 * voided. A voided run frees its week for a new draft. Only a draft may be
 * deleted.
 *
 * payroll_checks: one row per technician per run. The hours, rate, W-4 and every
 * money figure are SNAPSHOTS taken when the draft was worked out, so a later pay
 * rate or W-4 change never rewrites a finalized check. calc_snapshot keeps the
 * full computePaycheck output, withholding worksheet included.
 *
 * A finalized check is evidence. A trigger blocks DELETE, and the only UPDATEs
 * it lets through are finalized -> voided (when the run is voided) and setting
 * check_number while the check stays finalized. A voided check or run cannot
 * change at all.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('payroll_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.date('week_start').notNullable();
    t.date('pay_date').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.uuid('created_by').nullable().references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('finalized_by').nullable().references('id').inTable('technicians');
    t.timestamp('finalized_at', { useTz: true }).nullable();
    t.uuid('voided_by').nullable().references('id').inTable('technicians');
    t.timestamp('voided_at', { useTz: true }).nullable();
    t.text('void_reason').nullable();
  });
  await knex.raw(`ALTER TABLE payroll_runs
    ADD CONSTRAINT payroll_runs_status_check CHECK (status IN ('draft', 'finalized', 'voided')),
    ADD CONSTRAINT payroll_runs_week_monday_check CHECK (EXTRACT(ISODOW FROM week_start) = 1),
    ADD CONSTRAINT payroll_runs_pay_date_check CHECK (pay_date > week_start + 6),
    ADD CONSTRAINT payroll_runs_void_reason_check CHECK (void_reason IS NULL OR char_length(void_reason) <= 500)`);
  await knex.raw("CREATE UNIQUE INDEX payroll_runs_one_live_week ON payroll_runs (week_start) WHERE status <> 'voided'");
  await knex.raw('CREATE INDEX payroll_runs_week_idx ON payroll_runs (week_start DESC)');

  await knex.schema.createTable('payroll_checks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('run_id').notNullable().references('id').inTable('payroll_runs').onDelete('CASCADE');
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.text('employee_name').notNullable();
    t.date('week_start').notNullable();
    t.date('pay_date').notNullable();
    t.decimal('hourly_rate', 10, 2).notNullable();
    t.decimal('regular_minutes', 10, 2).notNullable();
    t.decimal('overtime_minutes', 10, 2).notNullable();
    t.bigInteger('gross_cents').notNullable();
    t.bigInteger('regular_pay_cents').notNullable();
    t.bigInteger('overtime_pay_cents').notNullable();
    t.bigInteger('overtime_premium_cents').notNullable();
    t.bigInteger('federal_income_tax_cents').notNullable();
    t.bigInteger('social_security_cents').notNullable();
    t.bigInteger('medicare_cents').notNullable();
    t.bigInteger('additional_medicare_cents').notNullable();
    t.bigInteger('net_cents').notNullable();
    t.bigInteger('employer_social_security_cents').notNullable();
    t.bigInteger('employer_medicare_cents').notNullable();
    t.bigInteger('futa_cents').notNullable();
    t.bigInteger('fl_reemployment_cents').notNullable();
    t.bigInteger('ytd_gross_before_cents').notNullable();
    t.uuid('w4_election_id').notNullable().references('id').inTable('payroll_w4_elections');
    t.jsonb('calc_snapshot').notNullable();
    t.text('pay_method').notNullable();
    t.text('check_number').nullable();
    t.text('status').notNullable().defaultTo('draft');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['run_id'], 'payroll_checks_run_idx');
    t.index(['technician_id', 'pay_date'], 'payroll_checks_tech_pay_date_idx');
  });
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_status_check CHECK (status IN ('draft', 'finalized', 'voided')),
    ADD CONSTRAINT payroll_checks_pay_method_check CHECK (pay_method IN ('check', 'bank_transfer')),
    ADD CONSTRAINT payroll_checks_check_number_check CHECK (check_number IS NULL OR (char_length(check_number) BETWEEN 1 AND 30)),
    ADD CONSTRAINT payroll_checks_minutes_check CHECK (regular_minutes >= 0 AND overtime_minutes >= 0 AND hourly_rate > 0),
    ADD CONSTRAINT payroll_checks_cents_check CHECK (
      gross_cents >= 0 AND regular_pay_cents >= 0 AND overtime_pay_cents >= 0 AND overtime_premium_cents >= 0
      AND federal_income_tax_cents >= 0 AND social_security_cents >= 0 AND medicare_cents >= 0
      AND additional_medicare_cents >= 0 AND net_cents >= 0 AND employer_social_security_cents >= 0
      AND employer_medicare_cents >= 0 AND futa_cents >= 0 AND fl_reemployment_cents >= 0
      AND ytd_gross_before_cents >= 0)`);
  await knex.raw("CREATE UNIQUE INDEX payroll_checks_one_live_week ON payroll_checks (technician_id, week_start) WHERE status <> 'voided'");

  await knex.raw(`CREATE FUNCTION protect_payroll_checks() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'draft' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A finalized or voided paycheck cannot be deleted; void its pay run instead';
      END IF;
      IF OLD.status = 'voided' THEN
        RAISE EXCEPTION 'A voided paycheck cannot be changed';
      END IF;
      IF (to_jsonb(NEW) - 'status' - 'check_number') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'check_number') THEN
        RAISE EXCEPTION 'A finalized paycheck cannot be edited; void its pay run instead';
      END IF;
      IF NEW.status = 'voided' THEN
        IF NEW.check_number IS DISTINCT FROM OLD.check_number THEN
          RAISE EXCEPTION 'A finalized paycheck cannot be edited; void its pay run instead';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.status <> 'finalized' THEN
        RAISE EXCEPTION 'A finalized paycheck can only be voided';
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw('CREATE TRIGGER protect_payroll_checks BEFORE UPDATE OR DELETE ON payroll_checks FOR EACH ROW EXECUTE FUNCTION protect_payroll_checks()');

  await knex.raw(`CREATE FUNCTION protect_payroll_runs() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status = 'draft' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A finalized or voided pay run cannot be deleted; void it instead';
      END IF;
      IF OLD.status = 'voided' THEN
        RAISE EXCEPTION 'A voided pay run cannot be changed';
      END IF;
      IF NEW.status <> 'voided'
        OR (to_jsonb(NEW) - 'status' - 'voided_by' - 'voided_at' - 'void_reason')
           IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voided_by' - 'voided_at' - 'void_reason') THEN
        RAISE EXCEPTION 'A finalized pay run can only be voided';
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw('CREATE TRIGGER protect_payroll_runs BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION protect_payroll_runs()');
};

exports.down = async function down(knex) {
  if (await knex('payroll_runs').first('id')) {
    throw new Error('payroll_runs holds paycheck evidence. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('DROP TRIGGER protect_payroll_checks ON payroll_checks');
  await knex.raw('DROP TRIGGER protect_payroll_runs ON payroll_runs');
  await knex.raw('DROP FUNCTION protect_payroll_checks()');
  await knex.raw('DROP FUNCTION protect_payroll_runs()');
  await knex.schema.dropTable('payroll_checks');
  await knex.schema.dropTable('payroll_runs');
};
