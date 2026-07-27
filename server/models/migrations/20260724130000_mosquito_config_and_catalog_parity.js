/**
 * Restate `pricing_config.mosquito_lot_sizes` in treatable sf.
 *
 * One drift, found by auditing prod against the engine:
 *
 * `pricing_config.mosquito_lot_sizes` still held the original April 2026
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
 * NOT DONE HERE — clearing `services.mosquito_one_time.base_price` ($250). An
 * earlier revision cleared it as a stale pre-June leftover. That premise was
 * WRONG: `20260606000001` set it to $99, then `20260704000010` blanket-nulled
 * base_price on EVERY service row (2026-07-04), and then on 2026-07-09 SIX
 * services were given round base prices in one batch — cockroach_control $350,
 * pest_initial_german_knockdown $450, one_time_pest_control $250,
 * mosquito_one_time $250, wdo_inspection $250, rodent_inspection $75. That is a
 * deliberate scheduling-default set, not drift, and singling mosquito out of it
 * would undo an owner decision.
 *
 * It may still be wrong on the merits — $250 is neither the $99 entry price nor
 * any bracket ($129/159/199/239/269) — and `admin-schedule.js:1005` prefers
 * `serviceRecord.base_price` over the estimate, so a hand-scheduled one-time
 * mosquito bills $250 regardless of area. Flagged for the owner as its own
 * decision (and it likely applies to the whole 07-09 batch, not just mosquito).
 *
 * NOT DONE HERE — activating `services.mosquito_seasonal`. It is `is_active =
 * false` while priceMosquito RECOMMENDS `seasonal9` for every low-pressure
 * property, so an accepted seasonal quote has no active catalog service to book
 * against. An earlier revision of this migration activated it. That was WRONG to
 * ship: `supportsConverterFollowUpSeeding` handles pest / foam / rodent /
 * termite-bait / tree-shrub and returns false for mosquito
 * (`server/services/estimate-converter.js:1319-1357`), so an accepted 9-visit
 * program books its FIRST visit and never seeds the other eight — the customer
 * is billed for a series they do not get. That is the same failure the T&S audit
 * hit ("a sold program produced ONE visit and no series", comment at :1341).
 * Activation also interacts with `loadBookableCallServices`, which selects every
 * `is_active && booking_enabled` row.
 *
 * Seasonal mosquito therefore needs converter series support (with its Feb-Oct
 * month constraint) BEFORE the catalog row is activated. Left for the owner as a
 * separate lane; this migration stays pure pricing parity.
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
// CURRENT threshold still equals the value below, so a bucket an admin tuned is
// left alone. ACRE carried no threshold in the legacy seed, hence undefined.
const LEGACY_MAX_BY_BUCKET = {
  SMALL: 10889, QUARTER: 14519, THIRD: 21779, HALF: 43559, ACRE: undefined,
};
// Detection is PER BUCKET, not a row-level SMALL+HALF signature. If one endpoint
// was corrected by hand while the others kept the acreage seed (SMALL = 7999,
// QUARTER/THIRD/HALF still 14519/21779/43559), a row-level signature skips the
// migration — and db-bridge's identical SMALL+HALF guard then also evaluates
// false, so it APPLIES those remaining gross-lot thresholds as live brackets.
// That is the exact bug this migration exists to remove.
//
// Two matching buckets are required so a single coincidence can't trigger a
// rewrite: 10889 is an odd number to hand-enter as a treatable-sf threshold, but
// one bucket alone is not evidence that the row is the acreage seed.
const MIN_LEGACY_BUCKETS_TO_REWRITE = 2;


function bucketMax(bucket) {
  if (!bucket || typeof bucket !== 'object') return undefined;
  const raw = bucket.maxSqFt ?? bucket.max_sqft;
  return raw == null ? undefined : Number(raw);
}

// Audit rows persist across up/down cycles, so a later no-op reapplication must
// NOT consume provenance from an earlier cycle — that would restore values this
// application never changed (legacy brackets, or a resurrected $250). Only an UP
// row with a HIGHER id than the most recent matching DOWN row belongs to the
// current cycle.
async function latestUncancelledUp(knex, { configKey, upReasonPrefix, downReasonPrefix }) {
  const lastDown = await knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG })
    .whereLike('reason', `${downReasonPrefix}%`)
    .orderBy('id', 'desc')
    .first('id');
  const query = knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG })
    .whereLike('reason', `${upReasonPrefix}%`)
    .orderBy('id', 'desc');
  if (lastDown?.id != null) query.where('id', '>', lastDown.id);
  return query.first('old_value', 'new_value');
}

// Mirrors validatePestPricingConfig's MOSQUITO.lotCategories check: thresholds
// must ascend in the engine's bucket order, with the terminal bucket unbounded.
// STRICTLY increasing, not merely non-descending: resolveMosquitoLotCategory
// takes the FIRST bucket whose max covers the area, so two equal endpoints make
// the later bucket unreachable and quote its properties at the earlier bucket's
// rate. A tuned SMALL=11999 next to a legacy QUARTER=14519 would otherwise
// rewrite to SMALL=11999, QUARTER=11999 and silently misprice.
const BUCKET_ORDER = ['SMALL', 'QUARTER', 'THIRD', 'HALF', 'ACRE'];
function isStrictlyAscending(row) {
  let previous = -Infinity;
  for (const bucket of BUCKET_ORDER) {
    const max = bucketMax(row[bucket]);
    // A malformed threshold (max_sqft: 'bad') yields NaN, and every NaN
    // comparison is false — so without this check the row would pass here, get
    // its legacy buckets rewritten, and then fail validatePestPricingConfig with
    // db-bridge's legacy-seed guard no longer matching. syncConstantsFromDB
    // would restore ALL pricing constants instead of loading DB-authoritative
    // pricing. Absent is legal only as the terminal unbounded bucket.
    const value = max === undefined ? Infinity : max;
    if (Number.isNaN(value)) return false;
    if (value !== Infinity && !Number.isFinite(value)) return false;
    if (value <= previous) return false;
    previous = value;
  }
  return true;
}

// jsonb does not preserve object-key order, so a stringify comparison against a
// value serialized before the DB round-trip can differ for identical content.
function sameShallowObject(a, b) {
  if (!a || !b) return a === b;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && String(a[k]) === String(b[k]));
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
    const legacyBuckets = Object.keys(TREATABLE_SF_SEED)
      .filter((bucket) => bucketMax(oldData[bucket]) === LEGACY_MAX_BY_BUCKET[bucket]);
    // ACRE carries no threshold in the acreage seed, so it matches `undefined`
    // and would count on a row that simply omits the bucket. Require the
    // evidence to include at least one real acreage number.
    const numericLegacy = legacyBuckets.filter((b) => LEGACY_MAX_BY_BUCKET[b] !== undefined);
    if (numericLegacy.length >= MIN_LEGACY_BUCKETS_TO_REWRITE) {
      const next = { ...oldData };
      const rewritten = [];
      const skipped = [];
      for (const [bucket, values] of Object.entries(TREATABLE_SF_SEED)) {
        if (!legacyBuckets.includes(bucket)) { skipped.push(bucket); continue; }
        const merged = { ...(oldData[bucket] || {}), ...values };
        // db-bridge reads `cfg?.maxSqFt ?? cfg?.max_sqft`, so a leftover
        // camel-case key takes PRECEDENCE and would keep the bridge on the old
        // acreage value — the row would look corrected while behaving as before.
        delete merged.maxSqFt;
        next[bucket] = merged;
        rewritten.push(bucket);
      }
      // A per-bucket rewrite can cross a NEIGHBOUR an admin tuned and leave the
      // row descending or duplicated — e.g. SMALL=13000 (tuned) with
      // QUARTER=14519 legacy becomes 13000, 11999; SMALL=11999 becomes a
      // duplicate 11999, 11999 that makes QUARTER unreachable. `validatePestPricingConfig` then fails the WHOLE
      // sync ("lotCategories must be sorted ascending") and
      // `restorePricingConstants` reverts EVERY pricing constant to in-code
      // defaults, so one mosquito row would silently disable DB-authoritative
      // pricing across all services. Never write a row that cannot load.
      if (rewritten.length && isStrictlyAscending(next)) {
        const reason = skipped.length
          ? `${UP_REASON} — left non-legacy bucket(s) alone: ${skipped.join(', ')}`
          : UP_REASON;
        // `rewrittenBuckets` is the rollback key: down() restores ONLY these,
        // so a bucket up() skipped is never clobbered on the way back out.
        await writeConfig(knex, LOT_SIZES_KEY, oldData, next, reason, { rewrittenBuckets: rewritten });
      }
    }
  }
};

exports.down = async function (knex) {
  // No audit table means no proof of what up() changed — leave the data alone
  // rather than guess.
  const hasAudit = await knex.schema.hasTable('pricing_config_audit');
  if (!hasAudit) return;

  const lotUp = await latestUncancelledUp(knex, {
    configKey: LOT_SIZES_KEY,
    upReasonPrefix: UP_REASON,
    downReasonPrefix: DOWN_REASON,
  });
  if (lotUp) {
    const snapshot = parseJson(lotUp.old_value) || {};
    const priorData = snapshot.data || {};
    const rewritten = Array.isArray(snapshot.rewrittenBuckets) ? snapshot.rewrittenBuckets : [];
    const applied = parseJson(lotUp.new_value) || {};
    const current = await readConfig(knex, LOT_SIZES_KEY);
    // Close the cycle no matter what. If the row was deleted or is unreadable we
    // cannot restore it, but leaving the UP record uncancelled means a later
    // no-op reapplication could consume this snapshot and reimpose legacy
    // acreage thresholds on a row it never touched.
    if (!current || !rewritten.length) {
      await knex('pricing_config_audit').insert({
        config_key: LOT_SIZES_KEY,
        old_value: JSON.stringify(applied),
        new_value: JSON.stringify({ reverted: [] }),
        changed_by: MIGRATION_TAG,
        reason: `${DOWN_REASON} — target row unavailable, nothing restored`,
      });
    }
    if (current && rewritten.length) {
      const next = { ...current };
      const reverted = [];
      for (const bucket of rewritten) {
        const currentBucket = next[bucket];
        const appliedBucket = applied[bucket];
        if (!currentBucket || !appliedBucket) continue;
        if (priorData[bucket] === undefined) {
          // up() created the bucket; only remove it if untouched since. The row
          // came back from a jsonb column, which does NOT preserve key order, so
          // compare canonically rather than by JSON.stringify.
          if (!sameShallowObject(currentBucket, appliedBucket)) continue;
          delete next[bucket];
          reverted.push(bucket);
          continue;
        }
        // Restore FIELD BY FIELD, and only fields still holding what up() wrote.
        // Replacing the whole bucket would erase a label (or any other property)
        // edited after the migration while max_sqft happened to be untouched.
        const thresholdUntouched = bucketMax(currentBucket) === bucketMax(appliedBucket);
        const restored = { ...currentBucket };
        let changed = false;
        for (const [field, appliedValue] of Object.entries(appliedBucket)) {
          if (String(restored[field]) !== String(appliedValue)) continue;
          if (Object.prototype.hasOwnProperty.call(priorData[bucket], field)) {
            restored[field] = priorData[bucket][field];
          } else {
            delete restored[field];
          }
          changed = true;
        }
        // The camel-case key up() deleted comes back only if it was there before
        // AND the threshold has not been edited since. db-bridge reads maxSqFt
        // BEFORE max_sqft, so restoring it over a newer max_sqft would let the
        // legacy acreage value silently shadow the admin's current threshold.
        if (thresholdUntouched
          && Object.prototype.hasOwnProperty.call(priorData[bucket], 'maxSqFt')
          && !Object.prototype.hasOwnProperty.call(restored, 'maxSqFt')) {
          restored.maxSqFt = priorData[bucket].maxSqFt;
          changed = true;
        }
        if (!changed) continue;
        next[bucket] = restored;
        reverted.push(bucket);
      }
      // The DOWN marker closes the cycle and MUST be written whenever the UP
      // record was consumed — including when an owner edit meant nothing needed
      // restoring. Writing it only on a successful revert leaves the UP record
      // "uncancelled", so a later no-op reapplication could consume this same
      // snapshot and restore legacy brackets it never applied.
      if (reverted.length) {
        await writeConfig(
          knex, LOT_SIZES_KEY, current, next,
          `${DOWN_REASON} — reverted: ${reverted.join(', ')}`
        );
      } else {
        await knex('pricing_config_audit').insert({
          config_key: LOT_SIZES_KEY,
          old_value: JSON.stringify(applied),
          new_value: JSON.stringify({ reverted: [] }),
          changed_by: MIGRATION_TAG,
          reason: `${DOWN_REASON} — nothing to revert (all buckets edited since up)`,
        });
      }
    }
  }
};
