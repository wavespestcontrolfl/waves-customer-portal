/**
 * stripe_orphan_charges.metadata (jsonb, nullable).
 *
 * An orphan row is written when Stripe collected a charge but the local
 * `payments` insert failed. For a monthly-autopay dues charge the row must
 * carry the month it collected FOR (metadata.billed_month, the same stamp
 * the cron writes on payments rows) so membership coverage on completion
 * can see that the month's dues WERE taken and not mint a monthly_rate
 * invoice on top of them. Both orphan writers stamp it; nothing else in the
 * column is read yet.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('stripe_orphan_charges'))) return;
  if (await knex.schema.hasColumn('stripe_orphan_charges', 'metadata')) return;
  await knex.schema.alterTable('stripe_orphan_charges', (t) => {
    t.jsonb('metadata');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('stripe_orphan_charges'))) return;
  if (!(await knex.schema.hasColumn('stripe_orphan_charges', 'metadata'))) return;
  await knex.schema.alterTable('stripe_orphan_charges', (t) => {
    t.dropColumn('metadata');
  });
};
