/**
 * Document the 2026-05-29 lawn-pricing regression baseline refresh.
 *
 * This migration does not change pricing rules. It records that the checked-in
 * LOCAL regression baselines (pricing-engine.local-baseline.json and
 * pricing-engine-v1-adapter.local-baseline.json) were recaptured after the Lawn
 * V2 dense 55%-cost-floor pricing shipped (PRs #1328 server-authoritative,
 * #1335 client parity, #1341 shared @waves/lawn-cost-floor module).
 *
 * Only the lawn-inclusive regression cases changed; every non-lawn case stayed
 * byte-identical. The new values are produced by the same engine the
 * lawn-pricing-golden-master suite validates exactly.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  const identity = {
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'claude-2026-05-29',
    category: 'documentation',
    summary: 'Refresh lawn regression baselines after Lawn V2 dense 55% cost-floor pricing.',
  };

  const existing = await knex('pricing_changelog').where(identity).first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify([
      'lawn_care',
      'waveguard_adapter_totals',
    ]),
    before_value: JSON.stringify({
      baseline_source: 'pre-Lawn-V2 bracket-table lawn pricing captured before the cost-floor switch',
      changed_cases: [
        'baseline_single_family_zone_a_quarterly_pest_enhanced_lawn',
        'zone_b_monthly_pest_bermuda_premium',
        'zone_c_bimonthly_pest_zoysia_standard_treeshrub',
        'zone_d_quarterly_pest_bahia_basic',
        'edge_large_footprint_5500sf_platinum_bundle',
        'platinum_bundle_4_qualifying_services_zone_a',
        'v1adapter_baseline_zone_a_quarterly_pest_lawn',
        'v1adapter_platinum_bundle_4_services_zone_a',
        'v1adapter_zone_c_bimonthly_pest_lawn_treeshrub',
        'v1adapter_zone_d_quarterly_pest_bahia',
      ],
    }),
    after_value: JSON.stringify({
      baseline_source: 'CAPTURE_BASELINE=1 LOCAL=1 (in-memory constants) — Lawn V2 LAWN_PRICING_V2_DENSE_55_FLOOR',
      shipped_in: ['#1328', '#1335', '#1341'],
      validation: 'lawn-pricing-golden-master.test.js + lawn-client-server-parity.test.js',
    }),
    rationale: 'Lawn V2 recurring pricing is the 55% collected-margin cost floor, not the old bracket table. The LOCAL regression baselines still held bracket-era lawn totals, so the lawn-inclusive cases failed. Recapture aligns the fixtures with the shipped cost-floor; only lawn-inclusive cases changed (all non-lawn cases byte-identical) and no pricing logic was introduced here. The DB-synced prod baselines (*.baseline.json) should be recaptured separately against prod once the deploy is confirmed.',
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'claude-2026-05-29',
      category: 'documentation',
      summary: 'Refresh lawn regression baselines after Lawn V2 dense 55% cost-floor pricing.',
    })
    .del();
};
