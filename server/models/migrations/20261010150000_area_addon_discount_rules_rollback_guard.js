/**
 * Rollback guard for 20261010100000 (area add-on discount rules).
 *
 * That migration's down() deletes a seeded service_discount_rules row by service key, its seeded note and
 * exclude_from_pct_discount true. The Pricing Logic panel edits tier_qualifier, max_discount_pct, flat_credit,
 * flat_credit_min_tier and exclude_from_pct_discount (the note is read-only there), so an operator who gave an add-on a
 * tier qualifier, a cap or a credit, and left the exclusion on, still matched the delete and lost the rule on rollback.
 * The file is pushed and frozen, so the guard lives here: a rollback runs THIS down() first (it is the later migration),
 * and it compares every seeded field of each rule the older down() would delete. A rule that differs in any of them gets a
 * different note, which is the one thing the older down() also matches on; the older down() then leaves the row as it is.
 * Only the note changes: no discount value, flag or credit of the rule is touched, so its pricing behavior is the same
 * before and after.
 *
 * up() changes nothing. A rule still equal to what was seeded is untouched, so an unedited rollback behaves exactly as before.
 */
const seed = require('./20261010100000_area_addon_discount_rules');

const KEPT_NOTE = `${seed.NOTE} Edited after the seed; kept on rollback (migration 20261010150000).`;

const isNull = (value) => value === null || value === undefined;

// Is this row still every field that 20261010100000 wrote? (The exclusion flag and the note decide whether the older down()
// matches at all; the other four fields are what the panel can change without leaving that match.)
function unchangedFromSeed(row) {
  return row.tier_qualifier === false
    && isNull(row.max_discount_pct)
    && isNull(row.flat_credit)
    && isNull(row.flat_credit_min_tier)
    && row.exclude_from_pct_discount === true
    && row.notes === seed.NOTE;
}

exports.KEPT_NOTE = KEPT_NOTE;
exports.unchangedFromSeed = unchangedFromSeed;

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_discount_rules'))) return;
  const rows = await knex('service_discount_rules').whereIn('service_key', seed.SERVICE_KEYS);
  for (const row of rows) {
    // A row the older down() would not match is already kept by it.
    if (row.notes !== seed.NOTE || row.exclude_from_pct_discount !== true) continue;
    if (unchangedFromSeed(row)) continue;
    await knex('service_discount_rules').where({ service_key: row.service_key, notes: seed.NOTE }).update({ notes: KEPT_NOTE });
  }
};
