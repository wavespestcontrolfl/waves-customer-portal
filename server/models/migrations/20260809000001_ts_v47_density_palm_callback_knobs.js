/**
 * Seed the v4.7 Tree & Shrub knobs into pricing_config at NEUTRAL values.
 *
 * The reprice lane (owner-approved 2026-08-08) adds three structural terms
 * to priceTreeShrub: a shrub-density multiplier on the measured-bed terms,
 * a routine palm-care reserve (material $/palm/yr + minutes/palm/visit),
 * and a per-visit callback reserve. All ship NEUTRAL (factors 1, dollars
 * and minutes 0) so quotes are unchanged until the owner flips calibrated
 * values — this migration only makes the knobs visible on the
 * ts_material_rates row so a flip is a data edit, not a deploy.
 *
 * Read-modify-write: admin edits to the row's other keys survive. A key
 * already present (e.g. a prior admin edit) is left alone.
 */
const MIGRATION_TAG = 'migration:20260809000001';
const UP_REASON = 'Seed neutral v4.7 T&S knobs (density factors, routine palm reserve, callback reserve) — reprice lane 2026-08-08, PR pending owner-calibrated values';
const NEUTRAL_KEYS = {
  density_light: 1,
  density_moderate: 1,
  density_heavy: 1,
  palm_per_palm_annual: 0,
  palm_minutes_per_visit: 0,
  callback_reserve_per_visit: 0,
};

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'ts_material_rates' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'ts_material_rates',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  const missing = Object.entries(NEUTRAL_KEYS).filter(([key]) => data[key] === undefined);
  if (!missing.length) return;
  const newData = { ...data, ...Object.fromEntries(missing) };
  await saveRow(knex, data, newData, UP_REASON);
};

exports.down = async function down(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  // Remove only keys still at their seeded neutral value — an owner-flipped
  // calibrated value is an admin edit this migration must not revert.
  const removable = Object.entries(NEUTRAL_KEYS)
    .filter(([key, neutral]) => Number(data[key]) === neutral)
    .map(([key]) => key);
  if (!removable.length) return;
  const newData = { ...data };
  for (const key of removable) delete newData[key];
  await saveRow(knex, data, newData, `${MIGRATION_TAG} down: remove seeded neutral v4.7 T&S knobs`);
};
