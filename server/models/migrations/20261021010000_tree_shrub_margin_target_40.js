/**
 * Migration — Tree & Shrub margin target 0.45 → 0.40 (owner audit 2026-10-21)
 *
 * `global_margin_target_ts` is DB-authoritative: db-bridge syncs it over
 * constants.GLOBAL.MARGIN_TARGET_TS / TREE_SHRUB.marginTarget whenever the
 * row carries semantics 'margin_admin_inclusive'. The owner's audit of sent
 * Tree & Shrub estimates found T&S was the one recurring program priced to a
 * 45% admin-inclusive margin while lawn and pest price to the 35% floor;
 * 40% cuts every T&S list price ~8.3% (× 0.55 / 0.60). Read-modify-write so
 * other keys in the row survive; the audit row is keyed by MIGRATION_TAG so
 * down() reverts only its own change.
 *
 * The post-discount margin guard (discount-engine.js#applyMarginGuard) has
 * been report-only since the 2026-07-17 owner ruling, so the cut reaches
 * bundled customers in full; `belowMarginFloor` simply flags more
 * WaveGuard-discounted T&S lines (Silver ~33%, Gold ~29%, Platinum ~25%).
 * Sent estimates replay their stamped pricing; only new quotes move.
 */
const MIGRATION_TAG = 'migration:20261021010000_tree_shrub_margin_target_40';
const UP_REASON = 'Owner audit 2026-10-21: Tree & Shrub margin target 0.45 -> 0.40 (admin-inclusive)';
const DOWN_REASON = 'Rollback: Tree & Shrub margin target 0.40 -> 0.45';
const CONFIG_KEY = 'global_margin_target_ts';

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  return { row, data };
}

async function writeValue(knex, data, value, reason) {
  const next = { ...data, value, semantics: 'margin_admin_inclusive' };
  await knex('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: JSON.stringify(data),
      new_value: JSON.stringify(next),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadRow(knex);
  // Only move a row still at the v4.6 value — an admin who already tuned it
  // keeps their number.
  if (loaded && Number(loaded.data.value) === 0.45) {
    await writeValue(knex, loaded.data, 0.40, UP_REASON);
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').insert({
      version_from: 'v4.9',
      version_to: 'v4.9',
      changed_by: 'claude-code',
      // pricing_changelog_category_check: bug|leak|rule|cost|architecture|documentation|infrastructure
      category: 'cost',
      summary: 'Tree & Shrub margin target 0.45 -> 0.40 (admin-inclusive); list prices x 0.55/0.60.',
      affected_services: JSON.stringify(['tree_shrub']),
      before_value: JSON.stringify({ marginTarget: 0.45, marginTargetSemantics: 'margin_admin_inclusive' }),
      after_value: JSON.stringify({ marginTarget: 0.40, marginTargetSemantics: 'margin_admin_inclusive', marginFloor: 0.35 }),
      rationale: 'Owner audit 2026-10-21: T&S was the only recurring program priced to a 45% admin-inclusive margin (lawn/pest price to the 35% floor) and sent quotes read high. The post-discount guard is report-only, so the cut reaches every customer; belowMarginFloor flags more WaveGuard-discounted T&S lines, which the owner reviews in the estimator.',
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const own = await knex('pricing_config_audit')
      .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
      .first('id');
    if (own) {
      const loaded = await loadRow(knex);
      if (loaded && Number(loaded.data.value) === 0.40) {
        await writeValue(knex, loaded.data, 0.45, DOWN_REASON);
      }
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog')
      .where({ version_from: 'v4.9', version_to: 'v4.9', category: 'cost' })
      .whereRaw("summary LIKE 'Tree & Shrub margin target 0.45%'")
      .del();
  }
};
