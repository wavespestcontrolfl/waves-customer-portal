// Populate SpeedZone Southern / EW (EPA 2217-1031) tank-mix, annual-cap, and
// rate-notes columns — owner-verified against the current specimen label + EPA
// PPLS.
//
// This ships separately from 20260704000002 (the reviewed-pesticides safety
// fields) because that migration was already merged: knex tracks migrations by
// filename, so editing a run migration is a silent no-op. New data => new file.
//
// - do_not_tank_mix_with (jsonb array): the label's spray-prep restrictions.
// - max_annual_per_1000 = 3.00: the SOUTHERN warm-season operational cap
//   (1.5 fl oz/1K max rate x 2 broadcast apps/site/year). The broader
//   label-wide seasonal ceiling (4.41 = 12 pt/A) is recorded in rate_notes
//   only, so it does not become the active southern-turf cap.
// - rate_notes (jsonb string): warm/cool-season rates, cap derivation,
//   retreatment intervals, spot-treatment limit.
//
// Matched by EPA reg (covers both SpeedZone rows). jsonb values are
// JSON.stringify'd per the existing seed-migration convention. Guarded to fill
// only null so a deliberate empty [] or an owner edit is never clobbered.

const SPEEDZONE_EPA = '2217-1031';

const SPEEDZONE_TANK_MIX = [
  'Additives that alter spray-solution pH below 5 or above 8.',
  'Liquid fertilizers or mixtures that fail jar-test compatibility, or that form flakes, sludge, gels, precipitates, a separate oily layer, or oil globules.',
  'Adjuvant or spray-additive combinations, unless prior experience shows the tank mixture will not cause objectionable turf injury.',
];
const SPEEDZONE_MAX_ANNUAL_PER_1000 = 3.0;
const SPEEDZONE_RATE_NOTES =
  'Waves / SW Florida warm-season turf listed on the label: 0.7–1.5 fl oz/1,000 sq ft (2–4 pt/A). ' +
  'Max operational annual/seasonal broadcast total is 3.00 fl oz/1,000 sq ft — the label allows at most 2 broadcast applications per site per year. ' +
  'Cool-season listed turf: 1.5–2.2 fl oz/1,000 sq ft (4–6 pt/A). ' +
  'Label-wide broadcast ceiling is 2.2 fl oz/1,000 sq ft per application and 4.41 fl oz/1,000 sq ft per season/year (12 pt/A); do not use that higher cap for southern warm-season residential turf unless the container label/site permits. ' +
  'Minimum retreatment interval: 30 days (non-cropland), 21 days (sod farms). Spot treatment cannot exceed 1,000 sq ft in any given acre.';

exports.up = async function up(knex) {
  const rows = await knex('products_catalog')
    .where({ epa_reg_number: SPEEDZONE_EPA })
    .select('id', 'do_not_tank_mix_with', 'max_annual_per_1000', 'rate_notes');
  for (const row of rows) {
    const patch = {};
    if (row.do_not_tank_mix_with == null) {
      patch.do_not_tank_mix_with = JSON.stringify(SPEEDZONE_TANK_MIX);
    }
    if (row.max_annual_per_1000 == null) {
      patch.max_annual_per_1000 = SPEEDZONE_MAX_ANNUAL_PER_1000;
    }
    if (row.rate_notes == null) {
      patch.rate_notes = JSON.stringify(SPEEDZONE_RATE_NOTES);
    }
    if (Object.keys(patch).length) {
      patch.updated_at = knex.fn.now();
      await knex('products_catalog').where({ id: row.id }).update(patch);
    }
  }
};

exports.down = async function down() {
  // Intentional no-op. `up` is fill-only, so it can't be reversed without a
  // per-row snapshot of the prior state — a value-matching rollback could erase
  // a pre-existing value this migration never wrote.
};
