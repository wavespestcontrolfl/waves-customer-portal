/**
 * Document the pest cadence curve v2 promotion (owner directive 2026-07-23).
 *
 * Code-only pricing change (the cadence curve lives in
 * pricing-engine/constants.js, not pricing_config): recurring pest bi-monthly
 * and monthly cadence multipliers move 0.85→0.88 and 0.70→0.78, and v2
 * becomes the engine default for NEW quotes (explicit services.pest.version
 * = 'v1' remains the legacy-replay channel). The checked-in regression
 * baselines (DB-synced + local, engine + v1-adapter) were recaptured to the
 * v2 curve in the same change — this row records that refresh per the
 * regression-suite contract.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  const identity = {
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'owner-2026-07-23',
    category: 'rule',
    summary: 'Pest recurring cadence curve v2 (1.00/0.88/0.78) becomes the live default; regression baselines recaptured.',
  };

  const existing = await knex('pricing_changelog')
    .where(identity)
    .first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify(['pest_control']),
    before_value: JSON.stringify({
      cadence_curve: { quarterly: 1.0, bimonthly: 0.85, monthly: 0.7 },
      engine_default: 'v1 (via the generateEstimate caller fallback)',
    }),
    after_value: JSON.stringify({
      cadence_curve: { quarterly: 1.0, bimonthly: 0.88, monthly: 0.78 },
      engine_default: 'v2 (pricePestControl default; explicit v1 = replay channel)',
      baseline_source: 'CAPTURE_BASELINE=1 recapture, DB-synced + local modes',
    }),
    rationale: 'Owner directive 2026-07-23: the v1 monthly 0.70 multiplier was a flat marketing discount that underpriced the visit — the cost model only saves ~5 on-site minutes at monthly cadence. Recurring pest only; one-time and other services unchanged. Baseline diffs are confined to bi-monthly/monthly pest tiers and bundle totals that include them.',
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'owner-2026-07-23',
      category: 'rule',
      summary: 'Pest recurring cadence curve v2 (1.00/0.88/0.78) becomes the live default; regression baselines recaptured.',
    })
    .del();
};
