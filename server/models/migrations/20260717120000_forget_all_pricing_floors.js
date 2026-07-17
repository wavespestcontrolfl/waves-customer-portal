// Forget all pricing floors (owner ruling 2026-07-17).
//
// Adam: "if something looks too low, I'll just tell the estimator to bring
// it up — forget all floors." Margins are SURFACED (quote margin fields,
// marginFloorOk flags, manual-discount warnings, the lawn margin sweep) and
// the owner adjusts prices in the estimator; nothing moves a price
// automatically anymore. This migration disarms the two DB-tunable floors:
//
// 1. lawn_pricing_v2.programMinimumMonthly → 0 — the $50/mo recurring lawn
//    program minimum (owner directive 2026-07-09, #2540). 0 is that lane's
//    designed disable value: the ladder clamp, the post-discount guard, the
//    prepay floor protection, and the below-floor requote backstops all
//    read this live and go inert at 0.
// 2. pest_base.enforce_floor_post_discount → false — the $79/visit
//    post-discount pest program floor (owner decision 2026-07-09, #2550).
//    The floor VALUE stays in the row for reporting/reference; only
//    enforcement is switched off (its designed kill switch).
//
// The lawn 35% cost floor and the WaveGuard margin-guard lift are disarmed
// in code in the same PR (useLawnCostFloor default false; applyMarginGuard
// is report-only) — they were never DB-gated.
//
// The quarterly (basic/4-app) lawn tier retirement from #2540 is CADENCE
// policy, not a floor — untouched here.
//
// Re-arm without a deploy: set lawn_pricing_v2.programMinimumMonthly back
// to a monthly dollar amount and/or pest_base.enforce_floor_post_discount
// back to true (db-bridge live-reads both). The in-code constants now
// default to the disarmed values, so the DOWN migration restores the
// pre-ruling values explicitly (50 / true) rather than deleting keys.

const CHANGED_BY = 'claude-2026-07-17';

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: CHANGED_BY,
  category: 'rule',
  summary: 'Forget all pricing floors: lawn $50/mo program minimum and pest $79/visit post-discount floor disarmed (owner ruling 2026-07-17).',
};

function parseConfigData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

async function readConfigData(knex, configKey) {
  const existing = await knex('pricing_config')
    .where({ config_key: configKey })
    .first('data');
  return { exists: !!existing, data: parseConfigData(existing?.data) };
}

async function writeConfigData(knex, configKey, data) {
  // Only rows that already exist are modified — a missing row means the
  // in-code constants govern, and those already carry the disarmed values.
  await knex('pricing_config')
    .where({ config_key: configKey })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
}

async function insertAudit(knex, configKey, oldSlice, newSlice, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: configKey,
    old_value: JSON.stringify(oldSlice),
    new_value: JSON.stringify(newSlice),
    changed_by: CHANGED_BY,
    reason,
  });
}

async function insertChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['lawn_care', 'pest_control', 'tree_shrub', 'waveguard_bundle_totals']),
    before_value: JSON.stringify({
      lawn_pricing_v2: { programMinimumMonthly: 50 },
      pest_base: { enforce_floor_post_discount: true },
      code: { useLawnCostFloor: true, marginGuardLift: true },
    }),
    after_value: JSON.stringify({
      lawn_pricing_v2: { programMinimumMonthly: 0 },
      pest_base: { enforce_floor_post_discount: false },
      code: { useLawnCostFloor: false, marginGuardLift: false },
    }),
    rationale: 'Owner ruling 2026-07-17: every estimate is owner-reviewed in the estimator with per-line margin visibility, so automatic price floors are redundant clamps that fight deliberate owner pricing (a below-floor adjustment was clamped back up at discount/accept time). All floors are disarmed: the $50/mo lawn program minimum, the $79/visit post-discount pest floor, the lawn 35% collected-margin cost floor, and the WaveGuard margin-guard lift. Market brackets price every quote; margins are surfaced, never enforced; the owner raises or lowers prices per estimate. One-time service minimums are price-book entries, not margin machinery, and are unchanged.',
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const lawn = await readConfigData(knex, 'lawn_pricing_v2');
  if (lawn.exists) {
    const oldValue = lawn.data.programMinimumMonthly ?? null;
    await writeConfigData(knex, 'lawn_pricing_v2', {
      ...lawn.data,
      programMinimumMonthly: 0,
    });
    await insertAudit(
      knex,
      'lawn_pricing_v2',
      { programMinimumMonthly: oldValue },
      { programMinimumMonthly: 0 },
      'Owner ruling 2026-07-17 (forget all floors): lawn program minimum disarmed; owner adjusts prices in the estimator.',
    );
  }

  const pest = await readConfigData(knex, 'pest_base');
  if (pest.exists) {
    const oldValue = typeof pest.data.enforce_floor_post_discount === 'boolean'
      ? pest.data.enforce_floor_post_discount
      : null;
    await writeConfigData(knex, 'pest_base', {
      ...pest.data,
      enforce_floor_post_discount: false,
    });
    await insertAudit(
      knex,
      'pest_base',
      { enforce_floor_post_discount: oldValue },
      { enforce_floor_post_discount: false },
      'Owner ruling 2026-07-17 (forget all floors): pest post-discount program floor disarmed via its designed kill switch; floor value retained for reporting.',
    );
  }

  await insertChangelog(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }

  // The in-code constants now default to the disarmed values, so rollback
  // must RESTORE the pre-ruling values explicitly — deleting the keys would
  // leave the floors off.
  const lawn = await readConfigData(knex, 'lawn_pricing_v2');
  if (lawn.exists) {
    await writeConfigData(knex, 'lawn_pricing_v2', {
      ...lawn.data,
      programMinimumMonthly: 50,
    });
    await insertAudit(
      knex,
      'lawn_pricing_v2',
      { programMinimumMonthly: lawn.data.programMinimumMonthly ?? null },
      { programMinimumMonthly: 50 },
      'Rollback: re-arm the $50/mo lawn program minimum (owner directive 2026-07-09 value).',
    );
  }

  const pest = await readConfigData(knex, 'pest_base');
  if (pest.exists) {
    await writeConfigData(knex, 'pest_base', {
      ...pest.data,
      enforce_floor_post_discount: true,
    });
    await insertAudit(
      knex,
      'pest_base',
      {
        enforce_floor_post_discount: typeof pest.data.enforce_floor_post_discount === 'boolean'
          ? pest.data.enforce_floor_post_discount
          : null,
      },
      { enforce_floor_post_discount: true },
      'Rollback: re-arm the $79/visit post-discount pest program floor (owner decision 2026-07-09).',
    );
  }
};
