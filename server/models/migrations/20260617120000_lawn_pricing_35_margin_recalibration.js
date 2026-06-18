/**
 * Recalibrate recurring lawn pricing from a 45% fully loaded floor to a 35%
 * fully loaded floor.
 *
 * Method (owner directive 2026-06-17): scale the existing 45% market bracket
 * curve by 0.55/0.65 ≈ 0.846 and lower the cost-floor target to 0.35. Lawn V2
 * is cost-floor authoritative (the charged price is max(market bracket, cost
 * floor at target margin)), so BOTH the bracket reference and the floor target
 * must move or the 45% floor would clamp prices back up. The scale factor is
 * the margin-equivalent transform: a cell that sat exactly at the 45% floor
 * lands at exactly 35%; richer market-priced cells stay above it. Every cell
 * was verified ≥35% fully loaded margin through the live engine (min 35.01%,
 * avg 42.0% across all 4 tracks × 4 tiers × bracket rows).
 */

const LAWN_PRICING_V2 = {
  targetCollectedMarginFloor: 0.35,
  laborRateLoaded: 35,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: { DENSE: 5, NORMAL: 10, LOOSE: 15, SPARSE: 20 },
  pricingMode: 'THIRTY_FIVE_MARGIN_FLOOR',
  pricingVersion: 'LAWN_PRICING_V2_DENSE_35_FLOOR',
};

// 45% curve × 0.846, rounded. Includes the sqft=0 seed row (mirrors the first
// real bracket); the runtime bridge drops it on load.
const BRACKETS_35 = {
  st_augustine: [
    [0,30,38,47,55],[3000,30,38,47,55],[3500,30,38,47,58],[4000,30,38,47,62],
    [5000,30,38,50,71],[6000,30,39,56,81],[7000,32,42,62,91],[8000,35,47,68,100],
    [10000,40,54,80,118],[12000,46,62,92,137],[15000,53,73,110,165],[20000,68,91,140,212],
  ],
  bermuda: [
    [0,34,42,51,63],[4000,34,42,51,63],[5000,34,42,51,73],[6000,34,42,57,82],
    [7000,34,43,63,91],[8000,36,47,69,102],[10000,41,55,81,120],[12000,47,63,94,140],
    [15000,55,74,112,168],[20000,69,94,143,217],
  ],
  zoysia: [
    [0,34,42,51,63],[4000,34,42,51,63],[5000,34,42,52,74],[6000,34,42,58,83],
    [7000,34,44,63,93],[8000,36,47,70,102],[10000,41,56,82,122],[12000,47,63,95,141],
    [15000,56,75,113,171],[20000,70,95,145,219],
  ],
  bahia: [
    [0,25,34,42,51],[3000,25,34,42,51],[3500,25,34,42,53],[4000,25,34,42,58],
    [5000,25,34,47,66],[6000,27,36,52,74],[7000,30,39,57,82],[8000,31,42,62,91],
    [10000,36,49,73,107],[12000,41,56,83,123],[15000,48,65,99,147],[20000,60,82,125,189],
  ],
};

// Prior 45% curve — restored on rollback.
const BRACKETS_45 = {
  st_augustine: [
    [0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],
    [5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],
    [10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250],
  ],
  bermuda: [
    [0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,60,86],[6000,40,50,67,97],
    [7000,40,51,74,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],
    [15000,65,88,132,199],[20000,81,111,169,256],
  ],
  zoysia: [
    [0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,61,87],[6000,40,50,68,98],
    [7000,40,52,75,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],
    [15000,66,89,134,202],[20000,83,112,171,259],
  ],
  bahia: [
    [0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],
    [5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],
    [10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223],
  ],
};

const TIERS = ['basic', 'standard', 'enhanced', 'premium'];

async function applyBrackets(knex, brackets) {
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) return;
  for (const [track, rows] of Object.entries(brackets)) {
    for (const row of rows) {
      const sqft = row[0];
      for (let i = 0; i < TIERS.length; i += 1) {
        await knex('lawn_pricing_brackets')
          .where({ grass_track: track, sqft_bracket: sqft, tier: TIERS[i] })
          .update({ monthly_price: row[i + 1], updated_at: knex.fn.now() });
      }
    }
  }
}

async function updateServices(knex, values) {
  if (!(await knex.schema.hasTable('services'))) return;
  // price_range_min is the catalog "from $X" floor read by admin
  // scheduling/service-library. Scale it with the bracket curve so it never
  // advertises a minimum the engine can now undercut (e.g. bahia basic $25/mo).
  const hasRangeMin = await knex.schema.hasColumn('services', 'price_range_min');
  for (const { service_key, base_price, price_range_min } of values) {
    const update = { base_price, updated_at: knex.fn.now() };
    if (hasRangeMin && price_range_min !== undefined) update.price_range_min = price_range_min;
    await knex('services')
      .where({ service_key })
      .update(update);
  }
}

async function mergeConfig(knex, data, name) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const hasIsActive = await knex.schema.hasColumn('pricing_config', 'is_active');
  // Read-modify-write: this row also carries keys owned by other migrations and
  // admin edits (e.g. the customer-facing `tiers` block from
  // 20260615000007_lawn_basic_customer_facing_metadata). We only own the
  // margin-floor fields, so merge our payload OVER the existing JSON instead of
  // replacing it wholesale — otherwise this silently undoes that metadata.
  const existing = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).first('data');
  let existingData = {};
  if (existing && existing.data != null) {
    try { existingData = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data; }
    catch { existingData = {}; }
  }
  const mergedData = { ...existingData, ...data };
  const insertRow = {
    config_key: 'lawn_pricing_v2',
    name,
    category: 'lawn',
    data: JSON.stringify(mergedData),
    sort_order: 4,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  };
  const mergeRow = { name, data: JSON.stringify(mergedData), updated_at: knex.fn.now() };
  if (hasIsActive) { insertRow.is_active = true; mergeRow.is_active = true; }
  await knex('pricing_config').insert(insertRow).onConflict('config_key').merge(mergeRow);
}

async function insertAudit(knex, oldFloor, newFloor) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: 'lawn_pricing_v2',
    old_value: oldFloor,
    new_value: newFloor,
    changed_by: 'claude-2026-06-17',
    reason: 'Lower recurring lawn fully loaded margin floor from 45% to 35% (owner directive); 45% market curve scaled ×0.846.',
  });
}

const CHANGELOG_IDENTITY = {
  version_from: 'v4.3',
  version_to: 'v4.3',
  changed_by: 'claude-2026-06-17',
  category: 'rule',
  summary: 'Recalibrate recurring lawn pricing to a 35% fully loaded floor.',
};

async function insertChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['lawn_care', 'one_time_lawn', 'waveguard_bundle_totals']),
    before_value: JSON.stringify({
      lawn_pricing_v2: { targetCollectedMarginFloor: 0.45, pricingMode: 'FORTY_FIVE_MARGIN_FLOOR' },
    }),
    after_value: JSON.stringify({ lawn_pricing_v2: LAWN_PRICING_V2 }),
    rationale: 'Owner directive 2026-06-17: lower the recurring lawn fully loaded margin floor from 45% to 35%. The 45% market bracket curve was scaled by 0.55/0.65 ≈ 0.846 (a ~15% list reduction) and the cost-floor target dropped to 0.35 so the floor does not clamp the lower curve. Every cell was verified ≥35% fully loaded LIST margin via the live engine. Note: lawn is NOT covered by the post-discount margin guard (applyMarginGuard handles only tree_shrub and pest_control); lawn WaveGuard discounts apply in full, capped only by the service discount percentage cap. So a discounted lawn line can fall BELOW the 35% list floor — e.g. a Silver 10% discount on a near-floor line lands in the high-20s collected margin. This is intended given the lower list floor. One-time lawn (priceOneTimeLawn) derives its base from the recurring per-app rate, so it drops ~15% with this reprice as well — confirmed in scope by the owner; one-time keeps a healthy margin via its 1.5x standalone multiplier, and the onetime_lawn config (floor/multipliers) is intentionally left unchanged.',
  });
}

exports.up = async function up(knex) {
  await mergeConfig(knex, LAWN_PRICING_V2, 'Lawn Pricing V2 Dense 35% Floor');
  await applyBrackets(knex, BRACKETS_35);
  await updateServices(knex, [
    { service_key: 'lawn_care_quarterly', base_price: 30.00, price_range_min: 25.00 },
    { service_key: 'lawn_care_recurring', base_price: 38.00, price_range_min: 30.00 },
    { service_key: 'lawn_care_6week', base_price: 47.00, price_range_min: 25.00 },
    { service_key: 'lawn_care_monthly', base_price: 55.00, price_range_min: 25.00 },
  ]);
  await insertAudit(knex, 0.45, 0.35);
  await insertChangelog(knex);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
  await mergeConfig(knex, {
    ...LAWN_PRICING_V2,
    targetCollectedMarginFloor: 0.45,
    pricingMode: 'FORTY_FIVE_MARGIN_FLOOR',
    pricingVersion: 'LAWN_PRICING_V2_DENSE_45_FLOOR',
  }, 'Lawn Pricing V2 Dense 45% Floor');
  await applyBrackets(knex, BRACKETS_45);
  await updateServices(knex, [
    { service_key: 'lawn_care_quarterly', base_price: 35.00, price_range_min: 30.00 },
    { service_key: 'lawn_care_recurring', base_price: 45.00, price_range_min: 36.00 },
    { service_key: 'lawn_care_6week', base_price: 55.00, price_range_min: 30.00 },
    { service_key: 'lawn_care_monthly', base_price: 65.00, price_range_min: 30.00 },
  ]);
  await insertAudit(knex, 0.35, 0.45);
};
