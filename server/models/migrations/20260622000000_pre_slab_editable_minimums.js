/**
 * Make the pre-slab termiticide contextual price floors part of the config row,
 * and drop the dead per-product floor fields.
 *
 * Pre-slab pricing is DB-authoritative (db-bridge.syncConstantsFromDB loads
 * `pricing_config.onetime_preslab` over the in-code constants). The pricing
 * engine's floors come from the contextual minimums table (lookupPreSlabMinimum),
 * but that table was never stored in the config row, so it fell through to the
 * constants.js defaults. Meanwhile each product carried
 * `floor_before_volume_discount` / `floor_after_volume_discount` fields that the
 * engine never reads — they rendered in the admin panel as editable inputs that
 * did nothing.
 *
 * Floors are stored as flat top-level array keys (minimums_standalone /
 * minimums_builderBatch / minimums_sameTripAddOn) rather than a nested
 * `minimums` object: the admin panel's inline table editor only persists
 * top-level keys, so flat keys are genuinely editable inline (a nested object
 * would render editable cells whose saves silently never reach the engine).
 *
 * This migration read-modify-writes the existing row to:
 *   1. populate each `minimums_<context>` flat key, only where absent —
 *      MIGRATING any floors already customized under the previously-supported
 *      nested `minimums` / `minimums_by_context` shape (never overriding them
 *      with defaults), then dropping the nested shape so flat is authoritative,
 *      and
 *   2. strip the dead per-product floor fields (snake_case + the camelCase
 *      aliases db-bridge used to accept).
 *
 * No price values change. down() is a faithful inverse driven by this
 * migration's audit snapshot: it removes a flat key only if up() created it AND
 * the floors still match exactly what up() wrote (key-order-independent compare,
 * because Postgres jsonb does not preserve object key order) — so a pre-existing
 * OR post-deploy admin-edited table survives rollback — and it restores the
 * pre-up nested shape and per-product floor fields from the snapshot.
 */
const MIGRATION_TAG = 'migration:20260622000000';
const UP_REASON = 'Pre-slab: seed contextual minimums (flat keys) + drop dead per-product floor fields';
const DOWN_REASON = 'Rollback: restore pre-slab per-product floor fields + remove seeded minimums';

// Flat top-level floor table key -> job context. Mirrors constants.js.
const CONTEXTS = [
  { flatKey: 'minimums_standalone', context: 'standalone' },
  { flatKey: 'minimums_builderBatch', context: 'builderBatch' },
  { flatKey: 'minimums_sameTripAddOn', context: 'sameTripAddOn' },
];

const DEFAULT_MINIMUMS = {
  minimums_standalone: [
    { maxSqFt: 250, floor: 225 },
    { maxSqFt: 750, floor: 325 },
    { maxSqFt: 1250, floor: 425 },
    { maxSqFt: 'Infinity', floor: 600 },
  ],
  minimums_builderBatch: [
    { maxSqFt: 250, floor: 150 },
    { maxSqFt: 750, floor: 250 },
    { maxSqFt: 1250, floor: 350 },
    { maxSqFt: 'Infinity', floor: 500 },
  ],
  minimums_sameTripAddOn: [
    { maxSqFt: 250, floor: 125 },
    { maxSqFt: 750, floor: 225 },
    { maxSqFt: 1250, floor: 325 },
    { maxSqFt: 'Infinity', floor: 500 },
  ],
};

// Dead per-product floor field aliases stripped by up() (db-bridge accepted both
// snake_case and camelCase before this PR removed the overlay).
const FLOOR_ALIASES = [
  'floor_before_volume_discount',
  'floor_after_volume_discount',
  'floorBeforeVolumeDiscount',
  'floorAfterVolumeDiscount',
];

function parseData(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Key-order-independent canonical serialization — Postgres jsonb does not
// preserve object key order, so a round-tripped `{ maxSqFt, floor }` must still
// compare equal to a freshly-built `{ maxSqFt, floor }`.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const floorsEqual = (a, b) => canonical(a) === canonical(b);

// The nested floor shape db-bridge accepted before this PR, if present.
function nestedMinimumsOf(data) {
  const nested = data.minimums;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
  const byContext = data.minimums_by_context;
  if (byContext && typeof byContext === 'object' && !Array.isArray(byContext)) return byContext;
  return null;
}

// What up() writes into a flat key that it is creating: a customized nested
// table for that context if one exists, otherwise the seeded default.
function valueUpWrites(sourceData, flatKey, context) {
  const nested = nestedMinimumsOf(sourceData);
  const nestedTiers = nested && Array.isArray(nested[context]) ? nested[context] : null;
  return nestedTiers || DEFAULT_MINIMUMS[flatKey];
}

function stripFloorAliases(product) {
  if (!product || typeof product !== 'object') return product;
  const rest = { ...product };
  for (const alias of FLOOR_ALIASES) delete rest[alias];
  return rest;
}

async function loadConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'onetime_preslab' }).first();
  if (!row) return null;
  const data = parseData(row.data);
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function save(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'onetime_preslab' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'onetime_preslab',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadConfig(knex);
  if (!loaded) return;
  const { data } = loaded;

  const newData = { ...data };
  // Populate each context's flat key only where absent — migrating any floors
  // already customized under the nested shape, else seeding the default.
  for (const { flatKey, context } of CONTEXTS) {
    if (Array.isArray(newData[flatKey])) continue; // pre-existing flat customization
    newData[flatKey] = JSON.parse(JSON.stringify(valueUpWrites(data, flatKey, context)));
  }
  // Consolidate onto the flat keys now that they carry the values.
  delete newData.minimums;
  delete newData.minimums_by_context;
  // Strip the dead per-product floor fields the engine never reads.
  if (newData.products && typeof newData.products === 'object') {
    newData.products = Object.fromEntries(
      Object.entries(newData.products).map(([key, product]) => [key, stripFloorAliases(product)]),
    );
  }
  await save(knex, data, newData, UP_REASON);
};

exports.down = async function down(knex) {
  // Only revert what this migration created — keyed off our audit row's pre-up
  // snapshot — so a pre-existing or post-deploy admin-edited floor table, and
  // any floor fields/nested shape we didn't author, survive an unrelated
  // rollback. No audit table means no proof of ownership; leave data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'onetime_preslab', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id', 'old_value');
  if (!ownUp) return;

  const loaded = await loadConfig(knex);
  if (!loaded) return;
  const { data } = loaded;
  const preUp = parseData(ownUp.old_value) || {};
  const preUpProducts = preUp.products || {};

  const newData = { ...data };
  // Remove a flat key only if up() created it (snapshot lacked it as a flat key)
  // AND it still matches exactly what up() wrote — order-independent, so a jsonb
  // key-order shuffle doesn't masquerade as an admin edit.
  for (const { flatKey, context } of CONTEXTS) {
    const addedByUp = !Array.isArray(preUp[flatKey]);
    if (addedByUp && floorsEqual(newData[flatKey], valueUpWrites(preUp, flatKey, context))) {
      delete newData[flatKey];
    }
  }
  // Restore the pre-up nested shape that up() consolidated away.
  if (preUp.minimums !== undefined) newData.minimums = preUp.minimums;
  if (preUp.minimums_by_context !== undefined) newData.minimums_by_context = preUp.minimums_by_context;
  // Restore each product's floor fields to exactly what the pre-up snapshot held.
  if (newData.products && typeof newData.products === 'object') {
    newData.products = Object.fromEntries(
      Object.entries(newData.products).map(([key, product]) => {
        if (!product || typeof product !== 'object') return [key, product];
        const old = preUpProducts[key] || {};
        const restored = { ...product };
        for (const alias of FLOOR_ALIASES) {
          if (old[alias] !== undefined) restored[alias] = old[alias];
        }
        return [key, restored];
      }),
    );
  }
  await save(knex, data, newData, DOWN_REASON);
};
