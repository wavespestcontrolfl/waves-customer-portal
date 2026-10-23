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
 *   - if the 20261021010000 UP audit row is the LATEST activity on the key,
 *     the live value moved in this application and the changelog is already
 *     true — nothing to do;
 *   - otherwise rewrite that changelog row to say the admin-tuned value
 *     (read live — even when it already reads 0.40) was preserved and still
 *     governs pricing; without the audit row no cut happened here.
 * down() restores the original summary, values and rationale only on the
 * row it rewrote.
 */
const PREV_TAG = 'migration:20261021010000_tree_shrub_margin_target_40';
const PREV_UP_REASON = 'Owner audit 2026-10-21: Tree & Shrub margin target 0.45 -> 0.40 (admin-inclusive)';
const CONFIG_KEY = 'global_margin_target_ts';
const ORIGINAL_SUMMARY = 'Tree & Shrub margin target 0.45 -> 0.40 (admin-inclusive); list prices x 0.55/0.60.';
const PRESERVED_PREFIX = 'Tree & Shrub margin target 0.45 -> 0.40 in code; the admin-tuned pricing_config row (';
// The rationale 20261021010000 wrote, restored with the summary on down()
// so a rolled-back row does not claim a cut and a preserved row at once
// (Codex #6398 r5).
const ORIGINAL_RATIONALE = 'Owner audit 2026-10-21: T&S was the only recurring program priced to a 45% admin-inclusive margin (lawn/pest price to the 35% floor) and sent quotes read high. The post-discount guard is report-only, so the cut reaches every customer; belowMarginFloor flags more WaveGuard-discounted T&S lines, which the owner reviews in the estimator.';

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
    // The audit row proves a move only while it is the LATEST activity on
    // the key. After a rollback and re-apply with an admin-tuned value in
    // place, 20261021010000 preserves the row (both ways) yet re-inserts the
    // "0.45 -> 0.40" changelog, and its historical UP audit still exists —
    // so a mere existence check would leave that fresh row lying (Codex
    // #6398 r21). Same ownership rule as that migration's down().
    const latest = await knex('pricing_config_audit')
      .where({ config_key: CONFIG_KEY })
      .orderBy('id', 'desc')
      .first('id', 'changed_by', 'reason');
    const moved = !!latest && latest.changed_by === PREV_TAG && latest.reason === PREV_UP_REASON;
    if (moved) return; // the row moved in this application; the changelog is already true
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
      rationale: ORIGINAL_RATIONALE,
    });
};
