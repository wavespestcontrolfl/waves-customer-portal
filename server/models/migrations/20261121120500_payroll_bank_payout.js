/**
 * "Pay out the bank" (owner 2026-11-21, "lets do these now"; handbook draft, section
 * "Paid time off", "When you leave"). Behind GATE_PAYROLL_TIME_OFF like the bank
 * itself (20261121110000_payroll_time_off_bank.js). Additive.
 *
 * technicians.pto_payout_week_start: the pay week (its first day) whose pay run pays
 * the technician every hour the time-off bank holds after that week, on their check.
 * NULL = no payout. Only the owner account sets it, with the "Pay out the bank"
 * button, one decision each time: the handbook pays unused hours at leaving, except
 * after a quit without 14 days' notice or a dismissal for misconduct. A pay week
 * starts on a Monday (payroll_runs_week_monday_check): any other day would never
 * match a pay run, and the payout would never be paid. A NULL column with no default
 * rewrites no row.
 *
 * payroll_runs.bank_payouts: the bank payouts this run decided, [{ technicianId,
 * name, hours }], written when the run is finalized (NULL when there was none). The
 * setting on the technician can move to another week later, and a payout of an empty
 * bank makes no check, so without this a finalized run would keep no record that it
 * was a payout run. protect_payroll_runs freezes a finalized row, so it is evidence
 * from then on. A check keeps the hours it paid out in calc_snapshot.ptoBank
 * .payoutMinutes, and those minutes are part of its pto_minutes, so the bank (the sum
 * of pto_earned_minutes - pto_minutes) reads zero after it with no other change.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE technicians
    ADD COLUMN pto_payout_week_start date NULL
      CONSTRAINT technicians_pto_payout_week_monday_check
      CHECK (pto_payout_week_start IS NULL OR EXTRACT(ISODOW FROM pto_payout_week_start) = 1)`);
  await knex.raw(`ALTER TABLE payroll_runs
    ADD COLUMN bank_payouts jsonb NULL
      CONSTRAINT payroll_runs_bank_payouts_check CHECK (bank_payouts IS NULL OR jsonb_typeof(bank_payouts) = 'array')`);
};

exports.down = async function down(knex) {
  // Lock first: a payout set, or a finalize, must not commit between the checks below and the DROP.
  await knex.raw('LOCK TABLE technicians, payroll_runs IN ACCESS EXCLUSIVE MODE');
  // A payout instruction decides a paycheck, and a kept payout is the record of one: preserve them and roll forward.
  if (await knex.schema.hasColumn('technicians', 'pto_payout_week_start')
    && await knex('technicians').whereNotNull('pto_payout_week_start').first('id')) {
    throw new Error('technicians holds a time-off bank payout week. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('payroll_runs', 'bank_payouts')
    && await knex('payroll_runs').whereNotNull('bank_payouts').first('id')) {
    throw new Error('payroll_runs holds time-off bank payouts. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE payroll_runs DROP COLUMN IF EXISTS bank_payouts');
  await knex.raw('ALTER TABLE technicians DROP COLUMN IF EXISTS pto_payout_week_start');
};
