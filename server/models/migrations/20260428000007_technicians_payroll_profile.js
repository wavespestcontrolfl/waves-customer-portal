/**
 * Per-tech payroll + personal info on the technicians table.
 *
 * Replaces the hardcoded LABOR_RATE = 35 in TimeTrackingPage's
 * dashboard with a real per-tech rate, and gives ops a single
 * source of truth for payroll-relevant facts (hire date, title,
 * employment type, address, DOB, emergency contact, SSN last 4)
 * instead of paper W-4s in a folder.
 *
 * SSN is intentionally last-4 only — the portal isn't a payroll
 * system of record. Full SSN stays in whatever payroll provider
 * actually files taxes. employment_type values: 'w2' | '1099' |
 * null. All columns nullable so existing rows are untouched.
 */
exports.up = async function (knex) {
  const cols = [
    ['pay_rate', t => t.decimal('pay_rate', 8, 2)],
    ['hire_date', t => t.date('hire_date')],
    ['job_title', t => t.string('job_title', 100)],
    ['employment_type', t => t.string('employment_type', 20)],
    ['address', t => t.text('address')],
    ['dob', t => t.date('dob')],
    ['emergency_contact_name', t => t.string('emergency_contact_name', 200)],
    ['emergency_contact_phone', t => t.string('emergency_contact_phone', 30)],
    ['ssn_last4', t => t.string('ssn_last4', 4)],
  ];
  for (const [name, addCol] of cols) {
    if (!(await knex.schema.hasColumn('technicians', name))) {
      await knex.schema.alterTable('technicians', addCol);
    }
  }
};

exports.down = async function (knex) {
  const cols = [
    'pay_rate', 'hire_date', 'job_title', 'employment_type',
    'address', 'dob', 'emergency_contact_name',
    'emergency_contact_phone', 'ssn_last4',
  ];
  for (const name of cols) {
    if (await knex.schema.hasColumn('technicians', name)) {
      await knex.schema.alterTable('technicians', t => t.dropColumn(name));
    }
  }
};
