/**
 * Changelog entry: Tree & Shrub bed-area cap REMOVED (owner ruling
 * 2026-08-10, verbatim: "no caps on bedding areas").
 *
 * This is a CODE-rule change, not a pricing_config change — the 8,000 sq ft
 * clamp lived in constants/property-calculator/service-pricing (and the V1
 * client mirror), so this migration only records the change in
 * pricing_changelog per the regression-baseline convention. Every bed-area
 * source (typed, estimated, lot-derived) now prices IN FULL; areas at/above
 * the 8,000 review threshold keep the bed_area_at_or_above_8000 manual-review
 * marker, which the autonomous routing already refuses to send without eyes.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const identity = {
    version_from: 'v4.7',
    version_to: 'v4.7',
    changed_by: 'claude-2026-08-10',
    category: 'rule',
    summary: 'Tree & Shrub bed-area cap removed — all sources price the full area; >=8k routes to review.',
  };
  const existing = await knex('pricing_changelog').where(identity).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify(['tree_shrub']),
    before_value: JSON.stringify({
      bedAreaCap: 8000,
      behavior: 'typed/estimated/lot-derived bed areas clamped to 8,000 sq ft (typed 14,000 priced as 8,000 — ~43% low)',
    }),
    after_value: JSON.stringify({
      bedAreaCap: null,
      reviewThresholdSqFt: 8000,
      behavior: 'all bed areas price in full; >=8,000 carries bed_area_at_or_above_8000 manual review',
    }),
    rationale: 'Owner ruling 2026-08-10: the cap was silently eating real operator measurements, not just inferences — a typed 14,000 sq ft bed priced ~43% low with only a panel note. Large areas now price in full and route to manual review instead. Local regression baseline (platinum-bundle fixture, T&S line 1381 -> 1951 annual) refreshed in the same PR; the DB-parity baseline requires a post-deploy recapture, same as the mosquito reprice precedent.',
  });
};

exports.down = async function (knex) {
  // Changelog rows are an audit trail — retained on rollback by design.
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
};
