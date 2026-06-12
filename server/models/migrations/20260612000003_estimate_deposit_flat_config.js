// Flat estimate-acceptance deposit amounts (owner decision 2026-06-12):
// $49 for recurring plans, $99 for one-time / intensive jobs, prepay-annual
// exempt. Seeded into pricing_config so the amounts are DB-authoritative —
// db-bridge syncConstantsFromDB() overlays this row onto constants.DEPOSIT,
// and the admin Pricing Logic panel can re-tune without a redeploy.
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;

  const existing = await knex('pricing_config').where({ config_key: 'estimate_deposit' }).first();
  if (existing) return;

  await knex('pricing_config').insert({
    config_key: 'estimate_deposit',
    name: 'Estimate Acceptance Deposit',
    category: 'global',
    data: JSON.stringify({ recurringAmount: 49, oneTimeAmount: 99 }),
    description: 'Flat deposit required to accept an estimate (credited toward the first visit). recurringAmount applies to recurring-plan acceptances, oneTimeAmount to one-time/intensive jobs. Prepay-annual acceptances are exempt.',
    sort_order: 95,
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;
  await knex('pricing_config').where({ config_key: 'estimate_deposit' }).del();
};
