/**
 * Document the 2026-05-19 pricing regression baseline refresh.
 *
 * This migration does not change pricing rules. It records that the checked-in
 * DB-synced regression baselines were recaptured after already-migrated pricing
 * config changes for pest production, one-time/mosquito alignment, and neutral
 * service-zone pricing.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  const identity = {
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'codex-2026-05-19',
    category: 'documentation',
    summary: 'Refresh pricing regression baselines after current DB pricing config changes.',
  };

  const existing = await knex('pricing_changelog')
    .where(identity)
    .first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify([
      'pest_control',
      'lawn_care',
      'tree_shrub',
      'mosquito',
      'one_time_pest',
      'waveguard_adapter_totals',
    ]),
    before_value: JSON.stringify({
      baseline_source: 'stale DB-synced regression fixtures from the prior refresh',
      notable_stale_assumptions: [
        'older pest recurring production values',
        'legacy service-zone multipliers in DB baseline cases',
        'older mosquito program option shape',
        'older one-time pest treatment total',
      ],
    }),
    after_value: JSON.stringify({
      baseline_source: 'CAPTURE_BASELINE=1 with syncConstantsFromDB() loading 57 pricing_config rows',
      pricing_config_changes_already_present: [
        '20260507000002_pest_production_pricing_config',
        '20260515000002_mosquito_onetime_pricing_alignment',
        '20260516000014_neutralize_service_zone_pricing',
      ],
    }),
    rationale: 'The source-only local baselines still pass with DB config disabled, while the DB-synced suites failed only against stale checked-in DB baseline totals. The recapture aligns regression fixtures with already-applied pricing_config migrations and does not introduce new pricing logic.',
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'codex-2026-05-19',
      category: 'documentation',
      summary: 'Refresh pricing regression baselines after current DB pricing config changes.',
    })
    .del();
};
