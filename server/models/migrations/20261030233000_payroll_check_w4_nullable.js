// A technician with no W-4 on file is withheld as the IRS default (single, no adjustments; Tax
// Topic 753), and no election row stands behind that check. payroll_w4_elections is evidence of
// a signed form, so no placeholder row is made: the check stores no election id instead.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payroll_checks'))) return;
  await knex.raw('ALTER TABLE payroll_checks ALTER COLUMN w4_election_id DROP NOT NULL');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payroll_checks'))) return;
  const withoutElection = await knex('payroll_checks').whereNull('w4_election_id').first('id');
  if (withoutElection) throw new Error('Checks without a W-4 election exist; cannot restore NOT NULL');
  await knex.raw('ALTER TABLE payroll_checks ALTER COLUMN w4_election_id SET NOT NULL');
};
