// Commercial pest exterior/interior split — changelog only (owner 2026-08-17).
//
// COMMERCIAL_PEST's cost buildup is decomposed into an exterior base
// (perimeter barrier + monitoring; carries overhead/drive/admin) and an
// interior service component (footprint-driven), each margined at the same
// 45% target. Component sums reproduce the pre-split buildup exactly
// (material base 4+2=6, base labor 15+10=25), so a default quote — interior
// included — is cent-identical to the pre-split price; this migration
// records the structural change, not a price move.
//
// The interior component is customer-selectable on the public estimate page
// (dark behind GATE_COMMERCIAL_INTERIOR_OPTION) and rep-selectable in the
// admin estimator (commercialInteriorService: 'excluded'). COMMERCIAL_PEST
// is code-only (no pricing_config row; db-bridge syncs no commercial_* key),
// so the change ships in the code diff; no pricing_config writes here.

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-17',
  category: 'architecture',
  summary: 'Commercial pest priced as exterior base + customer-selectable interior service component (owner 2026-08-17). Revenue-neutral when interior is selected (the default).',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['commercial_pest']),
    before_value: JSON.stringify({
      code: {
        COMMERCIAL_PEST: {
          materialPerVisitBase: 6,
          materialPerKSqFtPerVisit: 1.5,
          laborMinutesBase: 25,
          laborMinutesPerKSqFt: 6,
          laborMinutesPerimeterPer100Lf: 4,
          scope: 'single combined interior+exterior price',
        },
      },
    }),
    after_value: JSON.stringify({
      code: {
        COMMERCIAL_PEST: {
          exterior: { materialPerVisitBase: 4, laborMinutesBase: 15, laborMinutesPerimeterPer100Lf: 4 },
          interior: { materialPerVisitBase: 2, materialPerKSqFtPerVisit: 1.5, laborMinutesBase: 10, laborMinutesPerKSqFt: 6 },
          scope: 'exterior base + selectable interior component; combined = pre-split price',
        },
      },
    }),
    rationale: 'Owner ruling 2026-08-17: some commercial clients only want exterior service. The commercial pest program now prices an exterior-only base (perimeter barrier + monitoring, carrying overhead/drive/admin) with interior service as a size-priced, customer-visible component — included by default, removable on the public estimate page (GATE_COMMERCIAL_INTERIOR_OPTION) or preset by the rep in the estimator. Selecting interior reproduces the pre-split price exactly, so existing quoting behavior is unchanged until a customer or rep opts out.',
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
};
