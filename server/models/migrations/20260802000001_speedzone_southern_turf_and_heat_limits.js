// SpeedZone Southern: record the temperature and cultivar limits the label
// actually imposes (owner 2026-08-02: "fix speedzone to what you recommend").
//
// Background: the label says "Do not apply to Floratam, Bitterblue or other
// improved species of St. Augustine". Floratam is the dominant cultivar in our
// service area, which makes this the sharpest turf restriction in the catalog.
//
// The cultivar exclusion was ALREADY recorded — excluded_turf_species held
// ["floratam", "st_augustine_unknown_cultivar"] — so this does not re-litigate
// that. What was missing were the temperature and seasonal limits, which sat
// entirely unpopulated (max_temp_f, min_temp_f and heat_restrictions were all
// NULL) even though they are the constraints most likely to be breached on a
// SWFL summer route.
//
// Label limits captured here:
//  - Do not broadcast below 50°F or above 85°F ambient.
//  - Above 90°F, turf discoloration risk increases further.
//  - Do not broadcast or spot treat St. Augustinegrass during spring green-up,
//    during the fall-to-winter transition, or when temperatures are expected
//    below 40°F within 10 days of application.
//  - Over-application causes discoloration, thinning, stunting and turf death.
//
// Bitterblue is added to the cultivar exclusions because the label names it
// explicitly alongside Floratam; it was missing from the recorded list.
//
// NOTE (not fixed here, flagged for the owner): excluded_turf_species is
// surfaced only in the Protocol Reference tab
// (client/src/pages/admin/ProtocolReferenceTabV2.jsx). It is NOT shown in the
// completion product picker, which is where a technician actually chooses a
// product for a visit. Recorded-but-unsurfaced data does not prevent a
// misapplication; surfacing it there is a UI change beyond this migration.

const NAME = 'SpeedZone Southern';

// Exact current values (prod, 2026-08-02) — the migration only writes when the
// row still matches, so an admin edit in the meantime is never clobbered.
const PREV_EXCLUDED = ['floratam', 'st_augustine_unknown_cultivar'];
const NEXT_EXCLUDED = ['floratam', 'bitterblue', 'st_augustine_unknown_cultivar'];

const HEAT_RESTRICTIONS = [
  'Do not broadcast apply below 50°F or above 85°F ambient; above 90°F the risk of turf discoloration increases further.',
  'Do not broadcast or spot treat St. Augustinegrass during spring green-up, during the fall-to-winter transition, or when temperatures are expected to drop below 40°F within 10 days.',
  'Not labeled for Floratam, Bitterblue or other improved St. Augustine cultivars — confirm the cultivar before use.',
  'Over-application causes discoloration, thinning, stunting and turf death.',
].join(' ');

exports.NAME = NAME;
exports.HEAT_RESTRICTIONS = HEAT_RESTRICTIONS;
exports.NEXT_EXCLUDED = NEXT_EXCLUDED;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  // Temperature limits: only write while they are still unset, so a later
  // hand-entered value wins over this backfill.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .whereNull('max_temp_f')
    .whereNull('min_temp_f')
    .whereNull('heat_restrictions')
    .update({
      max_temp_f: 85,
      min_temp_f: 50,
      heat_restrictions: HEAT_RESTRICTIONS,
      updated_at: new Date(),
    });

  // Cultivar exclusions: only when the list is exactly what we recorded, so an
  // edited list is left alone.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .whereRaw('excluded_turf_species = ?::jsonb', [JSON.stringify(PREV_EXCLUDED)])
    .update({
      excluded_turf_species: JSON.stringify(NEXT_EXCLUDED),
      updated_at: new Date(),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  // All three values must still be exactly what up() wrote. Matching only the
  // restriction text would destroy a hand-edited bound that someone set after
  // up() ran while leaving the text alone — the same admin-edit-preserving
  // contract the forward direction honours.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .where('heat_restrictions', HEAT_RESTRICTIONS)
    .where('max_temp_f', 85)
    .where('min_temp_f', 50)
    .update({
      max_temp_f: null,
      min_temp_f: null,
      heat_restrictions: null,
      updated_at: new Date(),
    });

  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .whereRaw('excluded_turf_species = ?::jsonb', [JSON.stringify(NEXT_EXCLUDED)])
    .update({
      excluded_turf_species: JSON.stringify(PREV_EXCLUDED),
      updated_at: new Date(),
    });
};
