/**
 * Migration — make the 0.45 → 0.40 Tree & Shrub changelog row tell the truth
 * when the live row was preserved (Codex #6398 r1 P2 / r2 P2)
 *
 * 20261021010000 moves `global_margin_target_ts` only when the row still
 * reads 0.45 (an admin-tuned value is preserved), but it inserts the
 * "0.45 -> 0.40" changelog row unconditionally. In an environment where the
 * row was preserved, that changelog says the cut reached every customer
 * while db-bridge keeps loading the preserved value. The earlier file is
 * frozen as first pushed (a preview may already have recorded it in
 * knex_migrations, so an edit there would never run); this migration
 * corrects the row after the fact:
 *   - if the 20261021010000 audit row exists, the live value moved and the
 *     changelog is already true — nothing to do;
 *   - otherwise rewrite that changelog row to say the admin-tuned value
 *     (read live — even when it already reads 0.40) was preserved and still
 *     governs pricing; without the audit row no cut happened here.
 * down() restores the original wording only on the row it rewrote.
 */
const PREV_TAG = 'migration:20261021010000_tree_shrub_margin_target_40';
const PREV_UP_REASON = 'Owner audit 2026-10-21: Tree & Shrub margin target 0.45 -> 0.40 (admin-inclusive)';
const CONFIG_KEY = 'global_margin_target_ts';
const ORIGINAL_SUMMARY = 'Tree & Shrub margin target 0.45 -> 0.40 (admin-inclusive); list prices x 0.55/0.60.';
const PRESERVED_PREFIX = 'Tree & Shrub margin target 0.45 -> 0.40 in code; the admin-tuned pricing_config row (';

async function liveValue(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  const n = Number(data.value);
  return Number.isFinite(n) ? n : null;
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const moved = await knex('pricing_config_audit')
      .where({ config_key: CONFIG_KEY, changed_by: PREV_TAG, reason: PREV_UP_REASON })
      .first('id');
    if (moved) return; // the row moved; the changelog is already true
  }
  // No audit row means 20261021010000 did NOT move the row — including an
  // admin-tuned row that already read 0.40 (Codex #6398 r3): the changelog
  // still claims a cut that never happened here, so it is rewritten to the
  // live value whatever that value is.
  const current = await liveValue(knex);
  if (current === null) return; // no row at all: nothing to describe
  await knex('pricing_changelog')
    .where({ version_from: 'v4.9', version_to: 'v4.9', category: 'cost', summary: ORIGINAL_SUMMARY })
    .update({
      summary: `${PRESERVED_PREFIX}${current}) was preserved and still governs live pricing.`,
      before_value: JSON.stringify({ marginTarget: current, marginTargetSemantics: 'margin_admin_inclusive' }),
      after_value: JSON.stringify({ marginTarget: current, codeDefault: 0.40, rowMoved: false, marginTargetSemantics: 'margin_admin_inclusive', marginFloor: 0.35 }),
      rationale: 'Owner audit 2026-10-21: the in-code T&S margin target moved 0.45 -> 0.40, but this environment carried an admin-tuned global_margin_target_ts row, which 20261021010000 preserved; db-bridge keeps loading it, so live T&S pricing did not change here. Sent quotes replay their stamped pricingKnobs.marginTarget.',
    });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  await knex('pricing_changelog')
    .where({ version_from: 'v4.9', version_to: 'v4.9', category: 'cost' })
    .whereRaw('summary LIKE ?', [`${PRESERVED_PREFIX}%`])
    .update({
      summary: ORIGINAL_SUMMARY,
      before_value: JSON.stringify({ marginTarget: 0.45, marginTargetSemantics: 'margin_admin_inclusive' }),
      after_value: JSON.stringify({ marginTarget: 0.40, marginTargetSemantics: 'margin_admin_inclusive', marginFloor: 0.35 }),
    });
};
