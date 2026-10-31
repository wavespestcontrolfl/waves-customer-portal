/**
 * job_costs.charged_on_job_minutes and job_costs.charged_drive_minutes
 * (L11b, GATE_TECH_COST_RATES; open time, GATE_TECH_OPEN_TIME).
 *
 * With a technician cost card in effect, a visit is charged for its on-job minutes plus its drive minutes
 * (job-costing.js). Those minutes were not kept anywhere. The open time report needs them: the paid minutes
 * of a technician's day minus the minutes the day's visits carry. These two columns record, per visit, the
 * minutes the cost was charged for. NULL = no cost card was applied to that row (gate off, no card, or a
 * visit costed before the card): today's rows. Derived data; a recalculation rewrites it. Written whether
 * or not GATE_TECH_OPEN_TIME is on; nothing reads them while it is off.
 */
exports.up = async function up(knex) {
  const hasOnJob = await knex.schema.hasColumn('job_costs', 'charged_on_job_minutes');
  const hasDrive = await knex.schema.hasColumn('job_costs', 'charged_drive_minutes');
  if (hasOnJob && hasDrive) return;
  await knex.schema.alterTable('job_costs', (t) => {
    if (!hasOnJob) t.decimal('charged_on_job_minutes', 8, 2).nullable();
    if (!hasDrive) t.decimal('charged_drive_minutes', 8, 2).nullable();
  });
};

exports.down = async function down(knex) {
  const hasOnJob = await knex.schema.hasColumn('job_costs', 'charged_on_job_minutes');
  const hasDrive = await knex.schema.hasColumn('job_costs', 'charged_drive_minutes');
  if (!hasOnJob && !hasDrive) return;
  await knex.schema.alterTable('job_costs', (t) => {
    if (hasOnJob) t.dropColumn('charged_on_job_minutes');
    if (hasDrive) t.dropColumn('charged_drive_minutes');
  });
};
