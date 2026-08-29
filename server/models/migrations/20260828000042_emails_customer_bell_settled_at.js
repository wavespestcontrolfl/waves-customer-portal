// "Email from a customer" bell — split the per-email claim into a LEASE
// (customer_bell_claimed_at, reclaimable after it goes stale) and a terminal
// SETTLED marker (this column: delivered, or never-ring — bulk / control /
// ineligible / pre-rollout). A process exit between claim and delivery no
// longer loses the alert forever: the retry sweep reclaims a stale lease.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (await knex.schema.hasColumn('emails', 'customer_bell_settled_at')) return;
  await knex.schema.alterTable('emails', (table) => {
    table.timestamp('customer_bell_settled_at', { useTz: true }).nullable();
  });
  // Every row already claimed under the old permanent-claim semantics is
  // settled (pre-rollout mail was stamped claimed by 20260828000040; anything
  // claimed since either delivered or was deliberately marked handled).
  await knex('emails').whereNotNull('customer_bell_claimed_at').whereNull('customer_bell_settled_at')
    .update({ customer_bell_settled_at: knex.raw('customer_bell_claimed_at') });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (!(await knex.schema.hasColumn('emails', 'customer_bell_settled_at'))) return;
  await knex.schema.alterTable('emails', (table) => {
    table.dropColumn('customer_bell_settled_at');
  });
};
