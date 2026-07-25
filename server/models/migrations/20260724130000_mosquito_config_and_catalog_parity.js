/**
 * Bring the mosquito DB rows back in line with the live pricing engine.
 *
 * Three independent drifts, all found by auditing prod against the engine:
 *
 * 1. `pricing_config.mosquito_lot_sizes` still held the original April 2026
 *    seed, which stored GROSS lot acreage (1/4 acre = 10889 ... 1 acre = 43559).
 *    `MOSQUITO.lotCategories` brackets TREATABLE sf (footprint and hardscape
 *    already subtracted): 7999 / 11999 / 17999 / 34999 / unbounded. db-bridge
 *    neutralized the row with an exact-value guard, so live pricing was correct
 *    — but the admin Pricing Logic > Mosquito tab DISPLAYED the acreage numbers,
 *    and editing any value in the row would have stopped the guard matching and
 *    silently widened every bracket ~36% (most homes drop a bracket, i.e. get
 *    cheaper). Rewriting the row to treatable-sf values makes what the panel
 *    shows what the engine uses, and makes the guard inert. Labels carry
 *    "treatable sf" so nobody re-enters acreage by hand.
 *
 * 2. `services.mosquito_one_time.base_price` was $250.00 — a pre-2026-06 number
 *    (the June reprice moved one-time mosquito to $99-$269 by treatable area,
 *    `pricing_config.onetime_mosquito`). The row is `pricing_type='variable'`,
 *    so the engine prices it and base_price is only a fallback; a stale $250
 *    fallback can book or invoice the wrong amount. The other three mosquito
 *    rows already carry NULL. Blank, never $0 (a literal 0 becomes a real $0
 *    charge via the admin-schedule base_price fallback).
 *
 * 3. `services.mosquito_seasonal` was `is_active = false`, but priceMosquito
 *    RECOMMENDS `seasonal9` for every low-pressure property and labels the tier
 *    "Seasonal Mosquito Program (9 visits)". An accepted seasonal quote had no
 *    active catalog service to book against. Activated for internal/admin
 *    booking only — `booking_enabled` is left false, so this does not put the
 *    seasonal program on the public booking page (that flip is the owner's).
 */
const LOT_SIZES_KEY = 'mosquito_lot_sizes';
const MIGRATION_TAG = 'migration:20260724130000';
const UP_REASON = 'Mosquito lot-size brackets restated as treatable sf to match MOSQUITO.lotCategories (was gross lot acreage from the April 2026 seed)';
const DOWN_REASON = 'Rollback: restore gross-lot-acreage mosquito lot-size seed';

// Treatable sf, mirroring server/services/pricing-engine/constants.js
// MOSQUITO.lotCategories. ACRE is the terminal bucket: db-bridge maps
// >= 999999 to Infinity.
const TREATABLE_SF_SEED = {
  SMALL: { max_sqft: 7999, label: '< 8k treatable sf' },
  QUARTER: { max_sqft: 11999, label: '8k-12k treatable sf' },
  THIRD: { max_sqft: 17999, label: '12k-18k treatable sf' },
  HALF: { max_sqft: 34999, label: '18k-35k treatable sf' },
  ACRE: { max_sqft: 999999, label: '35k+ treatable sf' },
};

const LEGACY_GROSS_LOT_SEED = {
  SMALL: { max_sqft: 10889, label: '< 1/4 acre' },
  QUARTER: { max_sqft: 14519, label: '1/4 acre' },
  THIRD: { max_sqft: 21779, label: '1/3 acre' },
  HALF: { max_sqft: 43559, label: '1/2 acre' },
  ACRE: { label: '1+ acre' },
};

const ONE_TIME_KEY = 'mosquito_one_time';
const SEASONAL_KEY = 'mosquito_seasonal';
const STALE_ONE_TIME_BASE_PRICE = 250;

async function readConfig(knex, configKey) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: configKey }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function writeConfig(knex, configKey, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: configKey })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: configKey,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

// Read-modify-write per bucket so an admin edit to an unrelated field in the
// same JSON blob survives.
function mergeSeed(oldData, seed) {
  const next = { ...oldData };
  for (const [bucket, values] of Object.entries(seed)) {
    next[bucket] = { ...(oldData[bucket] || {}), ...values };
  }
  return next;
}

exports.up = async function (knex) {
  const oldData = await readConfig(knex, LOT_SIZES_KEY);
  if (oldData) {
    const smallMax = Number(oldData.SMALL?.max_sqft ?? oldData.SMALL?.maxSqFt);
    const halfMax = Number(oldData.HALF?.max_sqft ?? oldData.HALF?.maxSqFt);
    // Only rewrite the known-legacy acreage seed. A row already on treatable sf
    // (or deliberately tuned by the owner) is left alone; down() keys off the
    // audit row this branch skips writing.
    if (smallMax === 10889 && halfMax === 43559) {
      const newData = mergeSeed(oldData, TREATABLE_SF_SEED);
      // ACRE carried no max_sqft in the legacy seed; the terminal sentinel is
      // added by TREATABLE_SF_SEED above.
      await writeConfig(knex, LOT_SIZES_KEY, oldData, newData, UP_REASON);
    }
  }

  if (await knex.schema.hasTable('services')) {
    // Only clear the specific stale value, so a deliberate later edit survives.
    await knex('services')
      .where({ service_key: ONE_TIME_KEY })
      .where('base_price', STALE_ONE_TIME_BASE_PRICE)
      .update({ base_price: null, updated_at: knex.fn.now() });

    // booking_enabled intentionally untouched — public booking stays owner-gated.
    await knex('services')
      .where({ service_key: SEASONAL_KEY, is_active: false })
      .update({ is_active: true, updated_at: knex.fn.now() });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const ownUp = await knex('pricing_config_audit')
      .where({ config_key: LOT_SIZES_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
      .first('id');
    if (ownUp) {
      const oldData = await readConfig(knex, LOT_SIZES_KEY);
      if (oldData) {
        const reverted = mergeSeed(oldData, LEGACY_GROSS_LOT_SEED);
        delete reverted.ACRE.max_sqft;
        await writeConfig(knex, LOT_SIZES_KEY, oldData, reverted, DOWN_REASON);
      }
    }
  }

  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where({ service_key: ONE_TIME_KEY })
      .whereNull('base_price')
      .update({ base_price: STALE_ONE_TIME_BASE_PRICE, updated_at: knex.fn.now() });
    await knex('services')
      .where({ service_key: SEASONAL_KEY, is_active: true })
      .update({ is_active: false, updated_at: knex.fn.now() });
  }
};
