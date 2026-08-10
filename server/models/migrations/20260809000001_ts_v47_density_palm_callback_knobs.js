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
  // forUpdate: the admin pricing writer locks this row for its own
  // read-modify-write; without the lock here an admin edit committed
  // between this SELECT and the whole-JSON UPDATE below would be silently
  // overwritten. Knex migrations run transactionally, so the lock
  // serializes the two writers.
  const row = await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .forUpdate()
    .first();
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
  // Ownership comes from this migration's own audit trail: a key is ours to
  // remove only if it was ABSENT in the old_value up() recorded. A neutral
  // key that pre-existed up() (e.g. an admin already seeded density_light:1)
  // must survive rollback. No audit row → up() added nothing (skipped, or
  // audit table absent) → nothing to remove.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const auditRow = await knex('pricing_config_audit')
    .where({ config_key: 'ts_material_rates', changed_by: MIGRATION_TAG })
    .orderBy('id', 'desc')
    .first();
  if (!auditRow) return;
  let preUpData;
  try {
    preUpData = typeof auditRow.old_value === 'string'
      ? JSON.parse(auditRow.old_value) : auditRow.old_value;
  } catch {
    return;
  }
  if (!preUpData || typeof preUpData !== 'object') return;
  const removable = Object.entries(NEUTRAL_KEYS)
    // Ours (absent pre-up) AND still at the seeded neutral value — an
    // owner-flipped calibrated value is an admin edit down() must not touch.
    .filter(([key, neutral]) => preUpData[key] === undefined && Number(data[key]) === neutral)
    .map(([key]) => key);
  if (!removable.length) return;
  const newData = { ...data };
  for (const key of removable) delete newData[key];
  await saveRow(knex, data, newData, `${MIGRATION_TAG} down: remove seeded neutral v4.7 T&S knobs`);
};
