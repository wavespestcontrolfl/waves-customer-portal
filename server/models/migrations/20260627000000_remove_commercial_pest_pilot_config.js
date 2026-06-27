/**
 * Remove the small-commercial pest pilot pricing config (revert of PR #2139).
 *
 * PR #2139 was merged to main by accident and is being reverted. The revert
 * keeps the original seeding migration file (20260626000020) on disk — deleting
 * an already-applied migration would make Knex report the migrations directory
 * as corrupt and fail the next deploy. This follow-up migration instead removes
 * the seeded `commercial_pest_pilot` row so no dangling config is left behind:
 *
 *   - On an env that applied #2139: deletes the seeded (now-inert) row.
 *   - On a fresh env: the seeding migration runs first, this removes it — net
 *     state is no row, matching pre-#2139.
 *
 * Idempotent and safe whether or not the row / audit table exist. The pilot can
 * be re-landed later by re-merging the feature branch (which re-seeds the row).
 */
const CONFIG_KEY = 'commercial_pest_pilot';

exports.up = async function (knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    await knex('pricing_config').where({ config_key: CONFIG_KEY }).del();
  }
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').where({ config_key: CONFIG_KEY }).del();
  }
};

// No-op down: this is a cleanup for an accidental merge; rolling it back should
// not resurrect the reverted pilot config. Re-land the feature to restore it.
exports.down = async function () {};
