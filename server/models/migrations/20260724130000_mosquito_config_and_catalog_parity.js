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
 *    active catalog service to book against. Activated for internal/admin use
 *    only: `booking_enabled` is explicitly CLEARED in the same update, because
 *    `loadBookableCallServices` selects every `is_active && booking_enabled`
 *    service (`server/services/call-booking-catalog.js`) and the original seed
 *    (`20260507000002`) set `booking_enabled` true. Prod already carries false,
 *    but merely leaving the flag alone would put the seasonal program into
 *    automated call booking on any env where the seed value survived. Opening
 *    booking is an owner flip, never a migration's.
 *
 * ROLLBACK CONTRACT — `down()` restores from the provenance snapshot written by
 * `up()`, and only for fields `up()` actually changed AND that still hold the
 * value `up()` applied. A row that someone deliberately edited after this
 * migration ran is left alone rather than reverted to a pre-migration value.
 */
const LOT_SIZES_KEY = 'mosquito_lot_sizes';
const MIGRATION_TAG = 'migration:20260724130000';
const UP_REASON = 'Mosquito lot-size brackets restated as treatable sf to match MOSQUITO.lotCategories (was gross lot acreage from the April 2026 seed)';
const DOWN_REASON = 'Rollback: restore pre-migration mosquito lot-size brackets';

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

// The April 2026 acreage seed, per bucket. A bucket is only rewritten when its
// CURRENT threshold still equals the value below — an admin who tuned
// QUARTER/THIRD/ACRE while leaving the SMALL/HALF endpoints alone still trips
// the row-level signature, and a blind merge would discard that tuning.
// ACRE carried no threshold in the legacy seed, hence undefined.
const LEGACY_MAX_BY_BUCKET = {
  SMALL: 10889, QUARTER: 14519, THIRD: 21779, HALF: 43559, ACRE: undefined,
};
const LEGACY_SIGNATURE_BUCKETS = ['SMALL', 'HALF'];

const ONE_TIME_KEY = 'mosquito_one_time';
const SEASONAL_KEY = 'mosquito_seasonal';
const STALE_ONE_TIME_BASE_PRICE = 250;
// Provenance marker for the `services` edits. `pricing_config_audit` is the only
// migration-audit table available, and down() needs to know which catalog fields
// this migration actually changed — not just their current values.
const CATALOG_AUDIT_KEY = 'mosquito_catalog_parity';
const CATALOG_UP_REASON = 'Mosquito catalog parity: cleared stale one-time base_price and/or activated the seasonal program (booking_enabled held closed)';

function bucketMax(bucket) {
  if (!bucket || typeof bucket !== 'object') return undefined;
  const raw = bucket.maxSqFt ?? bucket.max_sqft;
  return raw == null ? undefined : Number(raw);
}

function parseJson(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function readConfig(knex, configKey) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: configKey }).first();
  if (!row) return null;
  const data = parseJson(row.data);
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function writeConfig(knex, configKey, oldData, newData, reason, appliedNote = null) {
  await knex('pricing_config')
    .where({ config_key: configKey })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: configKey,
      old_value: JSON.stringify(appliedNote ? { data: oldData, ...appliedNote } : oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const oldData = await readConfig(knex, LOT_SIZES_KEY);
  if (oldData) {
    const isLegacySeed = LEGACY_SIGNATURE_BUCKETS
      .every((bucket) => bucketMax(oldData[bucket]) === LEGACY_MAX_BY_BUCKET[bucket]);
    if (isLegacySeed) {
      const next = { ...oldData };
      const rewritten = [];
      const skipped = [];
      for (const [bucket, values] of Object.entries(TREATABLE_SF_SEED)) {
        const current = oldData[bucket] || {};
        if (bucketMax(current) !== LEGACY_MAX_BY_BUCKET[bucket]) { skipped.push(bucket); continue; }
        const merged = { ...current, ...values };
        // db-bridge reads `cfg?.maxSqFt ?? cfg?.max_sqft`, so a leftover
        // camel-case key takes PRECEDENCE and would keep the bridge on the old
        // acreage value — the row would look corrected while behaving as before.
        delete merged.maxSqFt;
        next[bucket] = merged;
        rewritten.push(bucket);
      }
      if (rewritten.length) {
        const reason = skipped.length
          ? `${UP_REASON} — left tuned bucket(s) alone: ${skipped.join(', ')}`
          : UP_REASON;
        // `rewrittenBuckets` is the rollback key: down() restores ONLY these,
        // so a bucket up() skipped is never clobbered on the way back out.
        await writeConfig(knex, LOT_SIZES_KEY, oldData, next, reason, { rewrittenBuckets: rewritten });
      }
    }
  }

  if (await knex.schema.hasTable('services')) {
    const prior = {};
    for (const key of [ONE_TIME_KEY, SEASONAL_KEY]) {
      const row = await knex('services')
        .where({ service_key: key })
        .first('base_price', 'is_active', 'booking_enabled');
      if (row) {
        prior[key] = {
          base_price: row.base_price,
          is_active: row.is_active,
          booking_enabled: row.booking_enabled,
        };
      }
    }

    // Only clear the specific stale value, so a deliberate later edit survives.
    const clearedOneTime = await knex('services')
      .where({ service_key: ONE_TIME_KEY })
      .where('base_price', STALE_ONE_TIME_BASE_PRICE)
      .update({ base_price: null, updated_at: knex.fn.now() });

    // booking_enabled is cleared in the SAME update as the activation: an
    // is_active row with booking_enabled true enters loadBookableCallServices.
    const activatedSeasonal = await knex('services')
      .where({ service_key: SEASONAL_KEY, is_active: false })
      .update({ is_active: true, booking_enabled: false, updated_at: knex.fn.now() });

    // Record what this migration actually changed. down() restores ONLY these
    // fields, and only while they still hold the applied value: on an env where
    // the catalog already had base_price NULL or seasonal active (a clean schema
    // seeds is_active true), an ungated rollback would stamp a stale $250 onto a
    // correct row and deactivate a service this migration never activated.
    if ((clearedOneTime || activatedSeasonal) && await knex.schema.hasTable('pricing_config_audit')) {
      await knex('pricing_config_audit').insert({
        config_key: CATALOG_AUDIT_KEY,
        old_value: JSON.stringify(prior),
        new_value: JSON.stringify({
          ...(clearedOneTime ? { [ONE_TIME_KEY]: { base_price: null } } : {}),
          ...(activatedSeasonal ? { [SEASONAL_KEY]: { is_active: true, booking_enabled: false } } : {}),
        }),
        changed_by: MIGRATION_TAG,
        reason: CATALOG_UP_REASON,
      });
    }
  }
};

exports.down = async function (knex) {
  // No audit table means no proof of what up() changed — leave the data alone
  // rather than guess.
  const hasAudit = await knex.schema.hasTable('pricing_config_audit');
  if (!hasAudit) return;

  const lotUp = await knex('pricing_config_audit')
    .where({ config_key: LOT_SIZES_KEY, changed_by: MIGRATION_TAG })
    .whereLike('reason', `${UP_REASON}%`)
    .orderBy('id', 'desc')
    .first('old_value', 'new_value');
  if (lotUp) {
    const snapshot = parseJson(lotUp.old_value) || {};
    const priorData = snapshot.data || {};
    const rewritten = Array.isArray(snapshot.rewrittenBuckets) ? snapshot.rewrittenBuckets : [];
    const applied = parseJson(lotUp.new_value) || {};
    const current = await readConfig(knex, LOT_SIZES_KEY);
    if (current && rewritten.length) {
      const next = { ...current };
      const reverted = [];
      for (const bucket of rewritten) {
        // Only revert a bucket still holding exactly what up() wrote; a value
        // tuned after the migration is the owner's, not ours to undo.
        if (bucketMax(next[bucket]) !== bucketMax(applied[bucket])) continue;
        if (priorData[bucket] === undefined) delete next[bucket];
        else next[bucket] = priorData[bucket];
        reverted.push(bucket);
      }
      if (reverted.length) {
        await writeConfig(
          knex, LOT_SIZES_KEY, current, next,
          `${DOWN_REASON} — reverted: ${reverted.join(', ')}`
        );
      }
    }
  }

  if (await knex.schema.hasTable('services')) {
    const catalogUp = await knex('pricing_config_audit')
      .where({ config_key: CATALOG_AUDIT_KEY, changed_by: MIGRATION_TAG, reason: CATALOG_UP_REASON })
      .orderBy('id', 'desc')
      .first('old_value', 'new_value');
    if (catalogUp) {
      const prior = parseJson(catalogUp.old_value) || {};
      const applied = parseJson(catalogUp.new_value) || {};
      for (const key of [ONE_TIME_KEY, SEASONAL_KEY]) {
        const appliedFields = applied[key];
        if (!appliedFields || !prior[key]) continue;
        const row = await knex('services')
          .where({ service_key: key })
          .first('base_price', 'is_active', 'booking_enabled');
        if (!row) continue;
        // Restore field-by-field, and only where the current value is still the
        // one up() applied — an owner edit made after the migration wins.
        const patch = {};
        for (const [field, appliedValue] of Object.entries(appliedFields)) {
          const currentValue = row[field];
          const stillApplied = appliedValue === null
            ? (currentValue === null || currentValue === undefined)
            : String(currentValue) === String(appliedValue);
          if (stillApplied) patch[field] = prior[key][field];
        }
        if (Object.keys(patch).length) {
          await knex('services')
            .where({ service_key: key })
            .update({ ...patch, updated_at: knex.fn.now() });
        }
      }
    }
  }
};
