/**
 * Payroll pay lines (owner ruling 2026-10-29, D5 part 1 of the first-technician
 * pay plan: "Build the payroll pieces now, switched off"). Dark behind
 * GATE_PAYROLL_PAY_LINES; additive.
 *
 * payroll_pay_lines: one row per bonus, commission, health allowance or employer
 * HSA contribution the owner wants paid on a W-2 technician's pay run. A line
 * waits 'open' until a pay run that covers its earned_week_start is FINALIZED;
 * then it is 'paid' and carries the check that paid it. Voiding that run puts it
 * back to 'open'. A paid line can never be edited or deleted (trigger below), and
 * the CHECKs keep the status and check_id in step.
 *
 * covers_from / covers_to: the span a commission or a monthly allowance covers.
 * Federal overtime law (29 CFR 778.120) spreads such pay equally over the
 * workweeks it covers; the pay run reads the approved hours of each of those
 * weeks. Both null = the earned week only. earned_week_start is a Monday and
 * not before the week that holds covers_to (a line is paid with or after the
 * period it covers).
 *
 * source_type / source_id: where an imported line came from. Unique when set, so
 * a later import cannot pay the same item twice.
 *
 * payroll_checks: new nullable columns, null on every existing row and on any
 * check made with the gate off. protect_payroll_checks compares whole rows with
 * to_jsonb, so a finalized check cannot change them either; that trigger is not
 * touched.
 *
 * technicians.flsa_overtime_covered: NULL = not set yet. W-2 box 12 code TT is
 * filled only for a technician set to true.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('payroll_pay_lines', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.text('kind').notNullable();
    t.integer('amount_cents').notNullable();
    t.date('earned_week_start').notNullable();
    t.date('covers_from').nullable();
    t.date('covers_to').nullable();
    t.text('source_type').nullable();
    t.text('source_id').nullable();
    t.text('note').nullable();
    t.text('status').notNullable().defaultTo('open');
    t.uuid('check_id').nullable().references('id').inTable('payroll_checks').onDelete('RESTRICT');
    t.uuid('created_by').nullable().references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['technician_id', 'status'], 'payroll_pay_lines_tech_status_idx');
    t.index(['check_id'], 'payroll_pay_lines_check_idx');
  });
  await knex.raw(`ALTER TABLE payroll_pay_lines
    ADD CONSTRAINT payroll_pay_lines_kind_check CHECK (kind IN ('review_bonus', 'commission', 'health_allowance', 'hsa_employer')),
    ADD CONSTRAINT payroll_pay_lines_amount_check CHECK (amount_cents > 0),
    ADD CONSTRAINT payroll_pay_lines_week_monday_check CHECK (EXTRACT(ISODOW FROM earned_week_start) = 1),
    ADD CONSTRAINT payroll_pay_lines_covers_pair_check CHECK ((covers_from IS NULL) = (covers_to IS NULL)),
    ADD CONSTRAINT payroll_pay_lines_covers_order_check CHECK (covers_from IS NULL OR covers_from <= covers_to),
    ADD CONSTRAINT payroll_pay_lines_paid_after_cover_check CHECK (
      covers_to IS NULL OR earned_week_start >= covers_to - (EXTRACT(ISODOW FROM covers_to)::int - 1)),
    ADD CONSTRAINT payroll_pay_lines_source_pair_check CHECK ((source_type IS NULL) = (source_id IS NULL)),
    ADD CONSTRAINT payroll_pay_lines_note_check CHECK (note IS NULL OR char_length(note) <= 500),
    ADD CONSTRAINT payroll_pay_lines_status_check CHECK (status IN ('open', 'paid', 'voided')),
    ADD CONSTRAINT payroll_pay_lines_paid_check_id_check CHECK ((status = 'paid') = (check_id IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX payroll_pay_lines_source_unique ON payroll_pay_lines (source_type, source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL`);

  // A paid line is evidence. It may only go back to open (a voided pay run), with
  // nothing else changed; it can never be deleted. A voided line is frozen.
  await knex.raw(`CREATE FUNCTION protect_payroll_pay_lines() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'open' THEN
          RAISE EXCEPTION 'A paid or voided pay line cannot be deleted';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'open' THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'voided' THEN
        RAISE EXCEPTION 'A voided pay line cannot be changed';
      END IF;
      IF NEW.status = 'open' AND NEW.check_id IS NULL
        AND (to_jsonb(NEW) - 'status' - 'check_id' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'check_id' - 'updated_at') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'A paid pay line cannot be changed; void its pay run to reopen it';
    END $$`);
  await knex.raw('CREATE TRIGGER protect_payroll_pay_lines BEFORE UPDATE OR DELETE ON payroll_pay_lines FOR EACH ROW EXECUTE FUNCTION protect_payroll_pay_lines()');

  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN review_bonus_cents bigint NULL,
    ADD COLUMN commission_cents bigint NULL,
    ADD COLUMN health_allowance_cents bigint NULL,
    ADD COLUMN hsa_employer_cents bigint NULL,
    ADD COLUMN line_overtime_premium_cents bigint NULL,
    ADD COLUMN qualified_overtime_cents bigint NULL,
    ADD COLUMN simple_compensation_cents bigint NULL`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_pay_lines_check CHECK (
      (review_bonus_cents IS NULL OR review_bonus_cents >= 0)
      AND (commission_cents IS NULL OR commission_cents >= 0)
      AND (health_allowance_cents IS NULL OR health_allowance_cents >= 0)
      AND (hsa_employer_cents IS NULL OR hsa_employer_cents >= 0)
      AND (line_overtime_premium_cents IS NULL OR line_overtime_premium_cents >= 0)
      AND (qualified_overtime_cents IS NULL OR qualified_overtime_cents >= 0)
      AND (simple_compensation_cents IS NULL OR simple_compensation_cents >= 0))`);

  await knex.raw('ALTER TABLE technicians ADD COLUMN flsa_overtime_covered boolean NULL');
};

exports.down = async function down(knex) {
  // Pay lines already entered or paid are payroll evidence: preserve them and roll forward.
  if (await knex.schema.hasTable('payroll_pay_lines') && await knex('payroll_pay_lines').first('id')) {
    throw new Error('payroll_pay_lines holds entries. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('payroll_checks', 'review_bonus_cents')
    && await knex('payroll_checks').whereNotNull('qualified_overtime_cents').first('id')) {
    throw new Error('payroll_checks holds pay line figures. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE technicians DROP COLUMN IF EXISTS flsa_overtime_covered');
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_pay_lines_check');
  await knex.raw(`ALTER TABLE payroll_checks
    DROP COLUMN IF EXISTS simple_compensation_cents,
    DROP COLUMN IF EXISTS qualified_overtime_cents,
    DROP COLUMN IF EXISTS line_overtime_premium_cents,
    DROP COLUMN IF EXISTS hsa_employer_cents,
    DROP COLUMN IF EXISTS health_allowance_cents,
    DROP COLUMN IF EXISTS commission_cents,
    DROP COLUMN IF EXISTS review_bonus_cents`);
  await knex.raw('DROP TRIGGER IF EXISTS protect_payroll_pay_lines ON payroll_pay_lines');
  await knex.raw('DROP FUNCTION IF EXISTS protect_payroll_pay_lines()');
  await knex.schema.dropTableIfExists('payroll_pay_lines');
};
