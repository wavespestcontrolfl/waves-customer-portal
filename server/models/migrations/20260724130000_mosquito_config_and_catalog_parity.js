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
// Provenance marker for the `services` edits. `pricing_config_audit` is the only
// migration-audit table available, and down() needs to know which catalog fields
// this migration actually changed — not just their current values.
const CATALOG_AUDIT_KEY = 'mosquito_catalog_parity';
const CATALOG_UP_REASON = 'Mosquito catalog parity: cleared stale one-time base_price and/or activated the seasonal program';

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

function bucketMax(bucket) {
  if (!bucket || typeof bucket !== 'object') return undefined;
  const raw = bucket.maxSqFt ?? bucket.max_sqft;
  return raw == null ? undefined : Number(raw);
}

// Read-modify-write per bucket so an admin edit to an unrelated field in the
// same JSON blob survives.
//
// `onlyWhenMax` restricts the rewrite to buckets whose CURRENT threshold still
// matches the value we expect to replace. An admin who tuned QUARTER/THIRD/ACRE
// while leaving the SMALL and HALF endpoints alone still trips the legacy-seed
// signature, and a blind merge would silently discard that tuning.
//
// Both key spellings are cleared before writing the canonical `max_sqft`:
// db-bridge reads `cfg?.maxSqFt ?? cfg?.max_sqft`, so a leftover camel-case key
// takes PRECEDENCE and would keep the bridge on the old value — the row would
// look corrected while behaving exactly as before.
function mergeSeed(oldData, seed, onlyWhenMax = null) {
  const next = { ...oldData };
  const skipped = [];
  for (const [bucket, values] of Object.entries(seed)) {
    const current = oldData[bucket] || {};
    if (onlyWhenMax) {
      const expected = onlyWhenMax[bucket];
      const actual = bucketMax(current);
      const matches = expected === undefined ? actual === undefined : actual === expected;
      if (!matches) { skipped.push(bucket); continue; }
    }
    const merged = { ...current, ...values };
    if (values.max_sqft !== undefined) delete merged.maxSqFt;
    next[bucket] = merged;
  }
  return { next, skipped };
}

exports.up = async function (knex) {
  const oldData = await readConfig(knex, LOT_SIZES_KEY);
  if (oldData) {
    // Only rewrite the known-legacy acreage seed. A row already on treatable sf
    // (or deliberately tuned by the owner) is left alone; down() keys off the
    // audit row this branch skips writing.
    if (bucketMax(oldData.SMALL) === 10889 && bucketMax(oldData.HALF) === 43559) {
      // ACRE carried no threshold in the legacy seed (undefined), so its
      // per-bucket guard expects undefined; the terminal 999999 sentinel comes
      // from TREATABLE_SF_SEED.
      const legacyMaxByBucket = {
        SMALL: 10889, QUARTER: 14519, THIRD: 21779, HALF: 43559, ACRE: undefined,
      };
      const { next, skipped } = mergeSeed(oldData, TREATABLE_SF_SEED, legacyMaxByBucket);
      const reason = skipped.length
        ? `${UP_REASON} — left tuned bucket(s) alone: ${skipped.join(', ')}`
        : UP_REASON;
      await writeConfig(knex, LOT_SIZES_KEY, oldData, next, reason);
    }
  }

  if (await knex.schema.hasTable('services')) {
    const prior = {};
    for (const key of [ONE_TIME_KEY, SEASONAL_KEY]) {
      const row = await knex('services').where({ service_key: key }).first('base_price', 'is_active');
      if (row) prior[key] = { base_price: row.base_price, is_active: row.is_active };
    }

    // Only clear the specific stale value, so a deliberate later edit survives.
    const clearedOneTime = await knex('services')
      .where({ service_key: ONE_TIME_KEY })
      .where('base_price', STALE_ONE_TIME_BASE_PRICE)
      .update({ base_price: null, updated_at: knex.fn.now() });

    // booking_enabled intentionally untouched — public booking stays owner-gated.
    const activatedSeasonal = await knex('services')
      .where({ service_key: SEASONAL_KEY, is_active: false })
      .update({ is_active: true, updated_at: knex.fn.now() });

    // Record what this migration actually changed. down() restores ONLY those
    // fields: on an env where the catalog already had base_price NULL or
    // seasonal active (a clean schema seeds is_active true), an ungated
    // rollback would stamp a stale $250 onto a correct row and deactivate a
    // service this migration never activated.
    if ((clearedOneTime || activatedSeasonal) && await knex.schema.hasTable('pricing_config_audit')) {
      await knex('pricing_config_audit').insert({
        config_key: CATALOG_AUDIT_KEY,
        old_value: JSON.stringify(prior),
        new_value: JSON.stringify({
          [ONE_TIME_KEY]: clearedOneTime ? { base_price: null } : 'unchanged',
          [SEASONAL_KEY]: activatedSeasonal ? { is_active: true } : 'unchanged',
        }),
        changed_by: MIGRATION_TAG,
        reason: CATALOG_UP_REASON,
      });
    }
  }
};

exports.down = async function (knex) {
  const hasAudit = await knex.schema.hasTable('pricing_config_audit');
  if (hasAudit) {
    const ownUp = await knex('pricing_config_audit')
      .where({ config_key: LOT_SIZES_KEY, changed_by: MIGRATION_TAG })
      .whereLike('reason', `${UP_REASON}%`)
      .first('id');
    if (ownUp) {
      const oldData = await readConfig(knex, LOT_SIZES_KEY);
      if (oldData) {
        const treatableMaxByBucket = {
          SMALL: 7999, QUARTER: 11999, THIRD: 17999, HALF: 34999, ACRE: 999999,
        };
        const { next } = mergeSeed(oldData, LEGACY_GROSS_LOT_SEED, treatableMaxByBucket);
        if (next.ACRE) delete next.ACRE.max_sqft;
        await writeConfig(knex, LOT_SIZES_KEY, oldData, next, DOWN_REASON);
      }
    }
  }

  // No audit table means no proof of what up() changed — leave the catalog alone
  // rather than guess.
  if (hasAudit && await knex.schema.hasTable('services')) {
    const ownUp = await knex('pricing_config_audit')
      .where({ config_key: CATALOG_AUDIT_KEY, changed_by: MIGRATION_TAG, reason: CATALOG_UP_REASON })
      .orderBy('id', 'desc')
      .first('old_value', 'new_value');
    if (ownUp) {
      const prior = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : ownUp.old_value;
      const applied = typeof ownUp.new_value === 'string' ? JSON.parse(ownUp.new_value) : ownUp.new_value;
      if (applied?.[ONE_TIME_KEY] !== 'unchanged' && prior?.[ONE_TIME_KEY]) {
        await knex('services')
          .where({ service_key: ONE_TIME_KEY })
          .update({ base_price: prior[ONE_TIME_KEY].base_price, updated_at: knex.fn.now() });
      }
      if (applied?.[SEASONAL_KEY] !== 'unchanged' && prior?.[SEASONAL_KEY]) {
        await knex('services')
          .where({ service_key: SEASONAL_KEY })
          .update({ is_active: prior[SEASONAL_KEY].is_active, updated_at: knex.fn.now() });
      }
    }
  }
};
