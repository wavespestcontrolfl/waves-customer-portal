/**
 * Rollback guard for 20261010120000 (area add-on protocol rows).
 *
 * That migration's down() deletes a seeded lawn_protocol_products row when its
 * role is still 'area_addon' and default_in_plan is false. It does not look at
 * the rate, unit, product, gates or yearly counter, so a row an operator edited
 * after the seed would be deleted on rollback and its live DB-backed protocol
 * state lost. The file is pushed and frozen, so the guard lives here: a
 * rollback runs THIS down() first (it is the later migration), and it marks
 * every seeded row whose seeded fields changed with role 'area_addon_kept'.
 * The older down() then leaves that row, its window and the protocol in place.
 *
 * up() changes nothing. A row still equal to what was seeded is untouched, so
 * an unedited rollback behaves exactly as before.
 */
const seed = require('./20261010120000_area_addon_protocol_rows');

const ACTION = 'area_addon_protocol_rows';
const KEPT_ROLE = 'area_addon_kept';
const TABLES = ['lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

const asObject = (value) => {
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
};
// Key order must not matter for a jsonb column read back from Postgres.
const stable = (value) => JSON.stringify(Object.keys(asObject(value)).sort().map((key) => [key, asObject(value)[key]]));

// Is this row still exactly what 20261010120000 wrote for the add-on its window names?
function unchangedFromSeed(row, addOn) {
  if (!addOn) return false;
  return row.product_name === addOn.product
    && Number(row.rate_per_1000) === Number(addOn.ratePer1000)
    && row.rate_unit === addOn.rateUnit
    && row.default_in_plan === false
    && stable(row.gates) === stable(seed.gatesOf(addOn))
    && stable(row.annual_counter) === stable(seed.counterOf(addOn));
}

exports.KEPT_ROLE = KEPT_ROLE;
exports.unchangedFromSeed = unchangedFromSeed;

exports.up = async function up() {};

exports.down = async function down(knex) {
  for (const table of TABLES) if (!(await knex.schema.hasTable(table))) return;
  const audits = await knex('lawn_protocol_audit_log').where({ action: ACTION });
  for (const audit of audits) {
    for (const id of asObject(audit.after_snapshot).products || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first();
      if (!row || row.role !== 'area_addon') continue;
      const window = await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).first('window_key');
      const addOn = seed.ADDONS.find((a) => a.serviceKey === (window && window.window_key));
      if (unchangedFromSeed(row, addOn)) continue;
      await knex('lawn_protocol_products').where({ id }).update({ role: KEPT_ROLE });
    }
  }
};
