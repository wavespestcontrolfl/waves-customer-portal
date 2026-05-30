/**
 * Document DB-synced pricing regression baseline parity for one-time pest.
 *
 * This migration does not change pricing rules. It records that the checked-in
 * DB-backed baseline now matches the current pricing_config values loaded by
 * syncConstantsFromDB().
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  const identity = {
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'codex-2026-05-30',
    category: 'documentation',
    summary: 'Refresh one-time pest DB-synced pricing regression baselines.',
  };

  const existing = await knex('pricing_changelog')
    .where(identity)
    .first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify(['one_time_pest']),
    before_value: JSON.stringify({
      onetime_pest_urgent_afterhours: 410,
      recurring_customer_onetime_pest_discount: 199,
      baseline_source: 'stale DB-synced regression fixture',
    }),
    after_value: JSON.stringify({
      onetime_pest_urgent_afterhours: 514,
      recurring_customer_onetime_pest_discount: 218,
      baseline_source: 'LOCAL=1 DATABASE_URL=... with syncConstantsFromDB() loading 61 pricing_config rows',
    }),
    rationale: 'The DB-backed regression suite was already loading current one-time pest pricing_config values that differ from the checked-in DB baseline. Source-only local baselines were left unchanged; this refresh documents DB parity only.',
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'codex-2026-05-30',
      category: 'documentation',
      summary: 'Refresh one-time pest DB-synced pricing regression baselines.',
    })
    .del();
};
