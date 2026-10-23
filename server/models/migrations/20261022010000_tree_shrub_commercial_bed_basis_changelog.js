/**
 * Migration — the 2026-10-21 Tree & Shrub area-input changelog row also
 * names the commercial program (Codex #6398 r6)
 *
 * 20261021000000 recorded the open-parcel bed basis against `tree_shrub`
 * only, but `priceCommercialTreeShrub` prices the lot-based bed the shared
 * `calculatePropertyProfile` computes, so lot-inferred `commercial_tree_shrub`
 * quotes moved too (a 40,000 sq ft lot with a 10,000 sq ft footprint: 7,200
 * → 4,320 sq ft of beds). The commercial tree backstop
 * (`COMMERCIAL_TREE_SHRUB.treeDensityCounts` 3/6/10) did NOT change. That
 * earlier file is frozen as first pushed (a preview may have recorded it in
 * knex_migrations), so this migration amends the row it inserted: adds the
 * commercial service to affected_services and records the unchanged
 * commercial table beside the residential 3/6/10 → 2/4/6 change. down()
 * restores the row as 20261021000000 wrote it.
 */
const SUMMARY_PREFIX = 'Tree & Shrub area inputs:';
const COMMERCIAL_NOTE = ' Also applies to commercial_tree_shrub, which prices the same lot-based bed (its 3/6/10 tree backstop is unchanged).';

async function findRow(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return null;
  return knex('pricing_changelog')
    .where({ version_from: 'v4.9', version_to: 'v4.9', category: 'cost' })
    .whereRaw('summary LIKE ?', [`${SUMMARY_PREFIX}%`])
    .first();
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));

exports.up = async function (knex) {
  const row = await findRow(knex);
  if (!row) return;
  const affected = Array.isArray(parse(row.affected_services)) ? parse(row.affected_services) : ['tree_shrub'];
  if (affected.includes('commercial_tree_shrub')) return; // already amended
  const before = parse(row.before_value);
  const after = parse(row.after_value);
  await knex('pricing_changelog').where({ id: row.id }).update({
    affected_services: JSON.stringify([...affected, 'commercial_tree_shrub']),
    before_value: JSON.stringify({ ...before, commercialTreeDensityFallbackCounts: { none: 0, light: 3, moderate: 6, heavy: 10 } }),
    after_value: JSON.stringify({ ...after, commercialTreeDensityFallbackCounts: { none: 0, light: 3, moderate: 6, heavy: 10 } }),
    rationale: `${row.rationale || ''}${COMMERCIAL_NOTE}`,
  });
};

exports.down = async function (knex) {
  const row = await findRow(knex);
  if (!row) return;
  const affected = Array.isArray(parse(row.affected_services)) ? parse(row.affected_services) : [];
  if (!affected.includes('commercial_tree_shrub')) return;
  const { commercialTreeDensityFallbackCounts: _b, ...before } = parse(row.before_value);
  const { commercialTreeDensityFallbackCounts: _a, ...after } = parse(row.after_value);
  await knex('pricing_changelog').where({ id: row.id }).update({
    affected_services: JSON.stringify(affected.filter((s) => s !== 'commercial_tree_shrub')),
    before_value: JSON.stringify(before),
    after_value: JSON.stringify(after),
    rationale: String(row.rationale || '').replace(COMMERCIAL_NOTE, ''),
  });
};
