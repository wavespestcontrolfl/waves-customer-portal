/**
 * WDO inspection fee → $250 FLAT (owner decision 2026-07-12, universal
 * one-time services plan Q8).
 *
 * Three sources disagreed: the estimate engine's stale lawn-sqft brackets
 * ($175/$200/$225 via SPECIALTY.wdo.brackets + the inert onetime_wdo row),
 * the auto-invoice structure-sqft tiers ($150/$200/$250,
 * admin-projects.js), and the tech quick-estimator's $125. All three
 * converge on $250 flat in the companion code changes; this migration
 * updates the pricing_config row (read-modify-write preserving any other
 * keys, audit row per house pattern). The db-bridge now READS onetime_wdo
 * (same PR) — before this it was seeded-but-dead config.
 *
 * The tech-entered inspection_fee on the WDO form still wins over the
 * flat default at invoice time (construction/history vary) — unchanged.
 */

const MIGRATION_TAG = 'migration:20260712500000';
const UP_REASON = 'WDO inspection fee → $250 flat (owner decision 2026-07-12, Q8)';
const FLAT_BRACKETS = [{ max_sqft: 999999, price: 250 }];

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'onetime_wdo' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  return { row, data };
}

async function saveData(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'onetime_wdo' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'onetime_wdo',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) {
    console.warn('[wdo-fee] onetime_wdo pricing_config row absent — skipping (constants default applies)');
    return;
  }
  const { data } = loaded;
  const current = Array.isArray(data.brackets) ? data.brackets : [];
  const alreadyFlat = current.length === 1
    && Number(current[0]?.price) === 250
    && Number(current[0]?.max_sqft) >= 999999;
  if (alreadyFlat) {
    console.log('[wdo-fee] onetime_wdo already $250 flat — no-op');
    return;
  }
  await saveData(knex, data, { ...data, brackets: FLAT_BRACKETS, prior_brackets: current }, UP_REASON);
  console.log(`[wdo-fee] onetime_wdo: ${JSON.stringify(current)} → $250 flat (prior kept in prior_brackets)`);
};

exports.down = async function down(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  if (!Array.isArray(data.prior_brackets)) {
    console.warn('[wdo-fee:down] no prior_brackets recorded — leaving row as-is');
    return;
  }
  const { prior_brackets: prior, ...rest } = data;
  await saveData(knex, data, { ...rest, brackets: prior }, 'rollback: restore pre-250-flat WDO brackets');
  console.log('[wdo-fee:down] onetime_wdo brackets restored');
};
