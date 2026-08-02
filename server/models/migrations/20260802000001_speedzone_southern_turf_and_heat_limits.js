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

  // Each safety field is handled INDEPENDENTLY, and the rule is "preserve
  // stricter, correct laxer" rather than "skip if touched".
  //
  // Requiring all three to be NULL was wrong: a row already holding
  // max_temp_f = 90 — an off-label ceiling — would have been skipped entirely
  // and kept it, which is the exact condition this migration exists to remove.
  // A partially populated row would likewise have kept its gaps.
  //
  // A stricter hand edit still wins: a ceiling below 85 or a floor above 50 is
  // someone deliberately being more careful than the label, and is left alone.

  // Ceiling: fill when unset, and pull down anything above the label limit.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .where(function whereLaxCeiling() {
      this.whereNull('max_temp_f').orWhere('max_temp_f', '>', 85);
    })
    .update({ max_temp_f: 85, updated_at: new Date() });

  // Floor: fill when unset, and raise anything below the label limit.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .where(function whereLaxFloor() {
      this.whereNull('min_temp_f').orWhere('min_temp_f', '<', 50);
    })
    .update({ min_temp_f: 50, updated_at: new Date() });

  // Prose: only when absent. Unlike a number, custom wording cannot be
  // compared for strictness, so an existing note is never overwritten.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [NAME])
    .whereNull('heat_restrictions')
    .update({ heat_restrictions: HEAT_RESTRICTIONS, updated_at: new Date() });

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

// Deliberately a no-op, for the same reason as the sibling migrations.
//
// Reverting by value cannot prove authorship. An environment that already
// excluded Bitterblue by hand, or already carried these bounds, was SKIPPED by
// up() — yet a value-matched down() would strip that hand-entered exclusion
// and null out bounds it never set. Removing a cultivar exclusion is the worst
// possible rollback failure here: Floratam and Bitterblue are the cultivars
// this product must never touch.
//
// Nothing recorded here is destructive — it is label truth that was simply
// missing — so there is no state worth restoring at the risk of deleting a
// safety exclusion. To undo it, edit the product in the admin catalog UI.
exports.down = async function down() {};

