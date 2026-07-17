/**
 * Version the spot-reserve lawn pricing floor (PR #2812).
 *
 * LAWN_MATERIAL_BUDGETS (packages/lawn-cost-floor) now fund the protocol
 * spot-treatment reserves (owner-approved 2026-07-16): ¼ of gated
 * fungicide/insecticide applications and ⅛ of herbicide spot, prorated to
 * the sold cadence. Floor-bound quote totals change, so estimates must
 * stamp a new pricingVersion — pricing_config is authoritative over
 * constants.js at runtime (db-bridge syncConstantsFromDB), so the stored
 * lawn_pricing_v2 row must move with the code or deployed envs would keep
 * stamping the old version. Read-modify-write preserves admin edits to
 * other keys in the row; audit + changelog rows record the change.
 */
const VERSION_FROM = 'LAWN_PRICING_V2_DENSE_35_FLOOR';
const VERSION_TO = 'LAWN_PRICING_V2_SPOT_RESERVE';
const MIGRATION_TAG = 'migration:20260717000001';

const BUDGETS_BEFORE = {
  st_augustine: { 4: 64, 6: 87, 9: 167, 12: 205 },
  bermuda: { 4: 57, 6: 87, 9: 164, 12: 215 },
  zoysia: { 4: 67, 6: 101, 9: 174, 12: 178 },
  bahia: { 4: 45, 6: 68, 9: 95, 12: 115 },
};
const BUDGETS_AFTER = {
  st_augustine: { 4: 75, 6: 103, 9: 182, 12: 225 },
  bermuda: { 4: 61, 6: 93, 9: 172, 12: 226 },
  zoysia: { 4: 83, 6: 124, 9: 205, 12: 219 },
  bahia: { 4: 52, 6: 78, 9: 107, 12: 131 },
};

const CHANGELOG_IDENTITY = {
  version_from: VERSION_FROM,
  version_to: VERSION_TO,
  changed_by: 'claude-2026-07-17',
  category: 'rule',
  summary: 'Lawn material budgets now fund protocol spot-treatment reserves.',
};

async function setPricingVersion(knex, version, reason) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).first();
  if (!row) return;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || data.pricingVersion === version) return;
  const before = data.pricingVersion;
  const newData = { ...data, pricingVersion: version };
  await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'lawn_pricing_v2',
      changed_by: MIGRATION_TAG,
      reason,
      old_value: JSON.stringify({ pricingVersion: before }),
      new_value: JSON.stringify({ pricingVersion: version }),
      changed_at: knex.fn.now(),
    }).catch(() => {});
  }
}

exports.up = async function up(knex) {
  await setPricingVersion(
    knex,
    VERSION_TO,
    'Spot-treatment reserves folded into LAWN_MATERIAL_BUDGETS (owner-approved 2026-07-16; PR #2812) — floor-priced quotes change, so stamped estimates need a distinguishable version.',
  );

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawn_material_budgets: BUDGETS_BEFORE }),
        after_value: JSON.stringify({ lawn_material_budgets: BUDGETS_AFTER }),
        rationale:
          'Owner decision 2026-07-16: fund the protocol spot-treatment reserves (protocols.json conditional_cost — 1/4 of gated fungicide/insecticide apps, 1/8 of herbicide spot; OR-alternative branches fund the max-cost branch) in the lawn cost floor so the 35% collected-margin guarantee holds when spot demand materializes. Reserve deltas prorated to the sold cadence via the protocol tier flags (standard->bronze, enhanced->enhanced, premium->premium, basic prorates bronze). Floor-bound quotes move up to ~$9/application; market-bracket-priced quotes unchanged. PR #2812.',
      });
    }
  }
};

exports.down = async function down(knex) {
  await setPricingVersion(
    knex,
    VERSION_FROM,
    'Rollback of 20260717000001 lawn spot-reserve version bump.',
  );
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
