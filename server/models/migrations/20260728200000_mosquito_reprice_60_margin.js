/**
 * Reprice mosquito (recurring + one-time) to a 60% target margin / pest-aligned
 * one-time ladder.
 *
 * Mosquito pricing is DB-authoritative: db-bridge.syncConstantsFromDB loads
 * `pricing_config.mosquito_base_prices` and `onetime_mosquito` over the
 * in-code constants at startup. The constants.js reprice is therefore inert
 * in any env carrying these rows unless we also update the DB. This migration
 * brings both rows in line with the new constants (and the refreshed
 * admin-pricing-config seed defaults) via read-modify-write: only the bucket
 * price keys are replaced, so admin edits to other keys in the same rows
 * (add-on prices, over-acre increment) survive.
 *
 * New per-visit [seasonal9, monthly12]: SMALL 73/66, QUARTER 76/69,
 * THIRD 79/73, HALF 86/77, ACRE 97/86 (uniform +10% over the 2026-06 band —
 * lands the real cost basis at a ~60% contribution margin).
 * One-time: 149/169/189/209/239/269 (~25% under the one-time pest band,
 * lot-bucket scaled; ESTATE/ACRE_CLASS held — never cut). Over-acre increment,
 * station/dunk add-ons and all multipliers unchanged.
 *
 * Shipped alongside an engine change (same PR): bucket prices now act as
 * anchors at each bucket's top edge and the engine interpolates between them
 * in 500-sf steps (owner directive — drive/setup dominate visit cost, so the
 * per-step increment shrinks as lots grow instead of jumping at boundaries).
 * The pricing_config data shape is unchanged.
 */
const MIGRATION_TAG = 'migration:20260728200000';

const NEW_RECURRING = {
  SMALL: { seasonal9: 73, monthly12: 66 },
  QUARTER: { seasonal9: 76, monthly12: 69 },
  THIRD: { seasonal9: 79, monthly12: 73 },
  HALF: { seasonal9: 86, monthly12: 77 },
  ACRE: { seasonal9: 97, monthly12: 86 },
};
const OLD_RECURRING = {
  SMALL: { seasonal9: 66, monthly12: 60 },
  QUARTER: { seasonal9: 69, monthly12: 63 },
  THIRD: { seasonal9: 72, monthly12: 66 },
  HALF: { seasonal9: 78, monthly12: 70 },
  ACRE: { seasonal9: 88, monthly12: 78 },
};
const NEW_ONE_TIME = {
  SMALL: 149,
  STANDARD: 169,
  LARGE: 189,
  XL: 209,
  ESTATE: 239,
  ACRE_CLASS: 269,
  OVER_ACRE: 269,
};
const OLD_ONE_TIME = {
  SMALL: 99,
  STANDARD: 129,
  LARGE: 159,
  XL: 199,
  ESTATE: 239,
  ACRE_CLASS: 269,
  OVER_ACRE: 269,
};
// Non-price keys carried only when the row is inserted fresh (missing-row
// envs); on existing rows they are preserved as-is.
const ONE_TIME_INSERT_DEFAULTS = {
  overAcreIncrementSqFt: 10000,
  overAcreIncrementPrice: 40,
  stationAddOn: 75,
  dunkAddOn: 15,
};

const CHANGELOG_IDENTITY = {
  version_from: 'v4.3',
  version_to: 'v4.3',
  changed_by: 'claude-2026-07-28',
  category: 'rule',
  summary: 'Reprice mosquito: recurring to 60% target margin (+10%), one-time to pest-aligned lot ladder.',
};

function parseData(row) {
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return data && typeof data === 'object' ? data : null;
}

async function upsertPriceKeys(knex, configKey, meta, priceKeys, insertDefaults, reason) {
  const row = await knex('pricing_config').where({ config_key: configKey }).first();
  const oldData = parseData(row);
  const newData = oldData
    ? { ...oldData, ...priceKeys }
    : { ...insertDefaults, ...priceKeys };
  if (row) {
    await knex('pricing_config')
      .where({ config_key: configKey })
      .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  } else {
    await knex('pricing_config').insert({
      config_key: configKey,
      ...meta,
      data: JSON.stringify(newData),
      updated_at: knex.fn.now(),
    });
  }
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: configKey,
      old_value: JSON.stringify(oldData || null),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

async function applyPrices(knex, recurring, oneTime, reason) {
  await upsertPriceKeys(
    knex,
    'mosquito_base_prices',
    { name: 'Mosquito Program Per-Visit Pricing', category: 'mosquito', sort_order: 2 },
    recurring,
    {},
    reason,
  );
  await upsertPriceKeys(
    knex,
    'onetime_mosquito',
    { name: 'One-Time Mosquito Treatment', category: 'one_time', sort_order: 5 },
    oneTime,
    ONE_TIME_INSERT_DEFAULTS,
    reason,
  );
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  await applyPrices(
    knex,
    NEW_RECURRING,
    NEW_ONE_TIME,
    'Mosquito reprice: recurring +10% to 60% target margin; one-time aligned ~25% under one-time pest (owner decision 2026-07-28)',
  );

  // Keep the service catalog (manual-appointment price defaults) aligned with
  // the new estimator pricing so manually added mosquito lines don't default
  // to the old band. Max = ACRE seasonal per-visit x the 2.0 pressure cap.
  if (await knex.schema.hasTable('services')) {
    await knex('services').where({ service_key: 'mosquito_monthly' }).update({
      base_price: 66,
      price_range_min: 66,
      price_range_max: 194,
      updated_at: knex.fn.now(),
    });
    await knex('services').where({ service_key: 'mosquito_one_time' }).update({
      base_price: 149,
      price_range_min: 149,
      price_range_max: 269,
      updated_at: knex.fn.now(),
    });
  }

  // Record the intentional pricing/baseline change.
  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['mosquito', 'one_time_mosquito']),
        before_value: JSON.stringify({
          mosquito_base_prices: { SMALL: [66, 60], QUARTER: [69, 63], THIRD: [72, 66], HALF: [78, 70], ACRE: [88, 78] },
          onetime_mosquito: { SMALL: 99, STANDARD: 129, LARGE: 159, XL: 199, ESTATE: 239, ACRE_CLASS: 269, OVER_ACRE: 269, overAcreIncrementPrice: 40 },
        }),
        after_value: JSON.stringify({
          mosquito_base_prices: { SMALL: [73, 66], QUARTER: [76, 69], THIRD: [79, 73], HALF: [86, 77], ACRE: [97, 86] },
          onetime_mosquito: { SMALL: 149, STANDARD: 169, LARGE: 189, XL: 209, ESTATE: 239, ACRE_CLASS: 269, OVER_ACRE: 269, overAcreIncrementPrice: 40 },
        }),
        rationale: 'Owner reprice 2026-07-28. Recurring: uniform +10% lands the real cost basis (Bifen 3oz+0.5oz/1000sf + Tekko 1oz, ~11min on-site via mist blower, 20min drive @ $35/hr loaded, $51/yr admin) at a ~60% contribution margin per bucket (seasonal 61-65%, monthly 60-62%); still well under Terminix mosquito+tick $131.11/mo and TruGreen $85.56/application. One-time: aligned to the one-time pest band (quarterly x 2.2, floor $199 -> ~$199-290 typical) minus ~25%, scaled by lot bucket; ESTATE/ACRE_CLASS held at 239/269 (already in band; mosquito rates never get cut). Add-ons, over-acre increment, and pressure multipliers unchanged. Bucket prices are now interpolation anchors (top-edge of each bucket) with 500-sf price steps between them — declining marginal rate so big lots are not priced out by bucket jumps. Client fallback engine recurring table was still on the pre-2026-06 band (105/90..195/175) and is synced to the new matrix + step curve in the same PR. Local regression baselines refreshed in the same PR; the DB-mode baseline cases require a post-deploy DB-parity recapture once these prices are live in prod (same as the 2026-06 reprice).',
      });
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }

  if (!(await knex.schema.hasTable('pricing_config'))) return;

  await applyPrices(
    knex,
    OLD_RECURRING,
    OLD_ONE_TIME,
    'Rollback mosquito reprice 20260728200000 to the 2026-06 band',
  );

  if (await knex.schema.hasTable('services')) {
    await knex('services').where({ service_key: 'mosquito_monthly' }).update({
      base_price: 60,
      price_range_min: 60,
      price_range_max: 175,
      updated_at: knex.fn.now(),
    });
    await knex('services').where({ service_key: 'mosquito_one_time' }).update({
      base_price: 99,
      price_range_min: 99,
      price_range_max: 269,
      updated_at: knex.fn.now(),
    });
  }
};
