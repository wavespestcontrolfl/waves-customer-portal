/**
 * Migration — Tree & Shrub area-input audit (owner, 2026-10-21)
 *
 * Changelog-only: records two input corrections to the residential Tree &
 * Shrub pricer. Neither value is DB-synced (`ts_material_rates` carries the
 * material terms; these two live in code), so no `pricing_config` row
 * changes here — the row is the audit trail so the reprice is visible next
 * to the v4.6 material model entry it adjusts.
 *
 *  1. Lot-based bed area is taken on the OPEN parcel (lot − building
 *     footprint − hardscape, pool/cage included), not the gross lot. The
 *     density percentage (light 10% / moderate 18% / heavy 25%, +5 for a
 *     moderate/complex landscape) is unchanged. A 10,000 sq ft lot with a
 *     2,500 sq ft home, drive and cage priced 1,800 sq ft of moderate beds;
 *     it now prices ~1,100. See property-calculator.js#treeShrubBedBasisSqFt.
 *  2. The no-count tree backstop (`TREE_SHRUB.treeDensityCounts`) drops from
 *     3/6/10 to 2/4/6 ornamental trees for light/moderate/heavy aerial tree
 *     density: the density read describes canopy generally, but the program
 *     only treats ornamentals, so mature oaks/pines were billed as sprayed
 *     plants (1.5 min/visit + $4/yr each). A stated count is unaffected.
 *
 * Sent estimates replay their stored engine inputs and keep their stamped
 * pricing; only new quotes see the change.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  await knex('pricing_changelog').insert({
    version_from: 'v4.9',
    version_to: 'v4.9',
    changed_by: 'claude-code',
    // Must be one of the pricing_changelog_category_check values
    // (bug|leak|rule|cost|architecture|documentation|infrastructure).
    category: 'cost',
    summary: 'Tree & Shrub area inputs: lot-based bed area moves to the open parcel (lot − footprint − hardscape); no-count tree backstop drops from 3/6/10 to 2/4/6 ornamental trees.',
    affected_services: JSON.stringify(['tree_shrub']),
    before_value: JSON.stringify({
      lotBasedBedBasis: 'gross_lot',
      treeDensityFallbackCounts: { none: 0, light: 3, moderate: 6, heavy: 10 },
    }),
    after_value: JSON.stringify({
      lotBasedBedBasis: 'lot_minus_footprint_minus_hardscape',
      treeDensityFallbackCounts: { none: 0, light: 2, moderate: 4, heavy: 6 },
    }),
    rationale: 'Owner audit 2026-10-21 of sent T&S estimates: quotes read high because the bed percentage ran on the gross lot (billing beds under the house, driveway and pool cage — the only area pricer that ignored the cage) and the aerial tree-density backstop billed shade canopy as sprayed ornamentals. Both are input corrections, not rate changes: the v4.6 material model, the 45% margin target and the $35 Standard backstop are untouched. Companion change: the aerial vision prompt now defines estimatedBedAreaSf (planted bed footprint only — no turf, hardscape or cage interior) and estimatedTreeCount (ornamental trees only; palms separate; mature oaks/pines excluded), which previously had no definition at all.',
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  await knex('pricing_changelog')
    .where({ version_from: 'v4.9', version_to: 'v4.9', category: 'cost' })
    .whereRaw("summary LIKE 'Tree & Shrub area inputs:%'")
    .del();
};
