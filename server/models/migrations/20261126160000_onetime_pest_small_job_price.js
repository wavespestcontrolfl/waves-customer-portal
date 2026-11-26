/**
 * Seed the small one-spot one-time pest price (owner 2026-11-26, "150 for
 * small one time jobs"; GATE_ONE_TIME_PEST_SMALL_JOB, dark).
 *
 * One-time pest pricing is DB-authoritative: db-bridge.syncConstantsFromDB
 * overlays `pricing_config.onetime_pest` on the in-code constants. This adds
 * the one missing key, `smallJobPrice: 150`, so the price lives in the same
 * row the Pricing Logic editor shows. Read-modify-write: the row's other keys
 * (floor, multiplier) and an existing smallJobPrice are left exactly as they
 * are. No price moves while the gate is off; nothing reads the key then.
 */
const CONFIG_KEY = 'onetime_pest';
const PRICE_KEY = 'smallJobPrice';
const PRICE = 150;
const MIGRATION_TAG = 'migration:20261126160000';
const UP_REASON = 'Add smallJobPrice 150 to onetime_pest (owner 2026-11-26 small one-spot job; PR #8603)';

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return null;
  const data = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) || {};
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadRow(knex);
  // No row: the code default (constants.js) applies; the admin seed carries the key.
  if (!loaded) return;
  const { data } = loaded;
  // A price already set (an admin edit) is left alone; down() keys off the
  // audit row this branch does not write.
  if (Object.prototype.hasOwnProperty.call(data, PRICE_KEY)) return;
  await saveRow(knex, data, { ...data, [PRICE_KEY]: PRICE }, UP_REASON);
};

exports.down = async function down(knex) {
  // Remove the key only when this migration's up() added it (its audit row),
  // and only while it still holds the seeded value: an admin edit survives.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  if (Number(data[PRICE_KEY]) !== PRICE) return;
  const { [PRICE_KEY]: _removed, ...rest } = data;
  await saveRow(knex, data, rest, `Revert: ${UP_REASON}`);
};
