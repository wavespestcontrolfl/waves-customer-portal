// Commercial pricing floors disarmed — changelog only (owner ruling 2026-08-17).
//
// Extends the 2026-07-17 "forget all pricing floors" ruling to the six
// commercial account minimums it missed (they were added 2026-06-30, before
// that ruling shipped): commercial lawn $1,200, tree & shrub $900, pest $900,
// mosquito $720, termite bait $900, rodent bait $900.
//
// Unlike the residential floors, the COMMERCIAL_* configs are CODE-ONLY —
// db-bridge syncs no commercial_* pricing_config key and no row exists — so
// the disarm itself ships in constants.js/service-pricing.js in this PR's
// code diff (the Math.max clamps are removed; minApplied stays as a
// report-only signal). This migration exists solely to record the pricing
// change in pricing_changelog, matching the 2026-07-17 precedent. No
// pricing_config rows are read or written.
//
// Also in the same PR: an explicit measured-zero bed area on commercial
// tree & shrub now routes to a manual quote instead of pricing at the old
// $900 minimum (an all-hardscape lot would otherwise price at the ~$220/yr
// admin-only buildup).

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-17',
  category: 'rule',
  summary: 'Commercial account minimums disarmed: all six commercial floors (lawn/tree-shrub/pest/mosquito/termite-bait/rodent-bait) are report-only (owner ruling 2026-08-17, extends 2026-07-17 no-floors ruling).',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify([
      'commercial_lawn',
      'commercial_tree_shrub',
      'commercial_pest',
      'commercial_mosquito',
      'commercial_termite_bait',
      'commercial_rodent_bait',
    ]),
    before_value: JSON.stringify({
      code: {
        COMMERCIAL_LAWN: { minAnnual: 1200, enforced: true },
        COMMERCIAL_TREE_SHRUB: { minAnnual: 900, enforced: true },
        COMMERCIAL_PEST: { minAnnual: 900, enforced: true },
        COMMERCIAL_MOSQUITO: { minAnnual: 720, enforced: true },
        COMMERCIAL_TERMITE_BAIT: { minAnnual: 900, enforced: true },
        COMMERCIAL_RODENT_BAIT: { minAnnual: 900, enforced: true },
      },
    }),
    after_value: JSON.stringify({
      code: {
        enforced: false,
        minAnnualRetainedAsReportOnlyReference: true,
        treeShrubExplicitZeroBed: 'manual_quote',
      },
    }),
    rationale: 'Owner ruling 2026-08-17: the commercial account minimums survived the 2026-07-17 forget-all-floors ruling by omission and were clamping cost-buildup prices up (e.g. a small quarterly commercial pest account clamped from ~$704/yr to $900/yr, shown as $225/application). Commercial pricing already carries a 45% target gross margin in the buildup, so the floors were posture, not cost recovery. All six commercial minimums are disarmed in code; minApplied remains a report-only signal. Explicit zero-bed commercial tree & shrub routes to manual quote instead of pricing at the admin-only buildup.',
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
};
