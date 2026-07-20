// Ownership fence for the report-delivery send claim (#2887 hardening).
// delivery_status='sending' alone can't distinguish WHICH request owns the
// claim: after the 10-minute stale takeover, the original (stalled but alive)
// request could revert or finalize over the new owner's claim, re-opening the
// duplicate-send window the claim exists to close. Each claim now writes a
// random token; every revert/finalize conditions on it.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  if (await knex.schema.hasColumn('projects', 'delivery_claim_token')) return;
  await knex.schema.alterTable('projects', (t) => {
    t.text('delivery_claim_token').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  if (!(await knex.schema.hasColumn('projects', 'delivery_claim_token'))) return;
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('delivery_claim_token');
  });
};
