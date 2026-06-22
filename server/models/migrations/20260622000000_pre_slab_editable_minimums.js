/**
 * Make the pre-slab termiticide contextual price floors part of the config row,
 * and drop the dead per-product floor fields.
 *
 * Pre-slab pricing is DB-authoritative (db-bridge.syncConstantsFromDB loads
 * `pricing_config.onetime_preslab` over the in-code constants). The pricing
 * engine's floors come from the contextual `minimums` table
 * (lookupPreSlabMinimum), but that table was never seeded into the config row,
 * so it fell through to the constants.js defaults. Meanwhile each product
 * carried `floor_before_volume_discount` / `floor_after_volume_discount` fields
 * that the engine never reads — they rendered in the admin panel as editable
 * inputs that did nothing.
 *
 * This migration read-modify-writes the existing row to:
 *   1. add the `minimums` block (mirroring constants.js) ONLY if absent —
 *      preserving any admin edits already present, and
 *   2. strip the dead per-product floor fields (both snake_case and the
 *      camelCase aliases db-bridge used to accept).
 *
 * No price values change. `minimums` is nested, so it is edited via the admin
 * panel's "Raw Edit" JSON box (the same as other nested configs such as
 * `onetime_flea` tiers) — the inline cell editor only persists top-level keys.
 *
 * down() is a faithful inverse driven by this migration's audit snapshot: it
 * removes `minimums` only if up() created it (the pre-up snapshot lacked it),
 * and restores each product's floor fields to exactly what the snapshot held —
 * so pre-existing/admin-edited minimums survive a rollback.
 */
const MIGRATION_TAG = 'migration:20260622000000';
const UP_REASON = 'Pre-slab: seed contextual minimums + drop dead per-product floor fields';
const DOWN_REASON = 'Rollback: restore pre-slab per-product floor fields + remove seeded minimums';

const DEFAULT_MINIMUMS = {
  standalone: [
    { maxSqFt: 250, floor: 225 },
    { maxSqFt: 750, floor: 325 },
    { maxSqFt: 1250, floor: 425 },
    { maxSqFt: 'Infinity', floor: 600 },
  ],
  builderBatch: [
    { maxSqFt: 250, floor: 150 },
    { maxSqFt: 750, floor: 250 },
    { maxSqFt: 1250, floor: 350 },
    { maxSqFt: 'Infinity', floor: 500 },
  ],
  sameTripAddOn: [
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
  // Add the floors table only if absent — never clobber admin edits.
  if (!newData.minimums || typeof newData.minimums !== 'object') {
    newData.minimums = JSON.parse(JSON.stringify(DEFAULT_MINIMUMS));
  }
  // Strip the dead per-product floor fields the engine never reads.
  if (newData.products && typeof newData.products === 'object') {
    newData.products = Object.fromEntries(
      Object.entries(newData.products).map(([key, product]) => [key, stripFloorAliases(product)]),
    );
  }
  await save(knex, data, newData, UP_REASON);
};

exports.down = async function down(knex) {
  // Only revert what this migration created — keyed off our audit row's
  // pre-up snapshot — so a pre-existing or later-edited `minimums` block, and
  // any floor fields we didn't actually add, survive an unrelated rollback.
  // No audit table means no proof of ownership; leave data alone.
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
  // Remove `minimums` only if up() is the one that introduced it.
  if (!preUp.minimums || typeof preUp.minimums !== 'object') {
    delete newData.minimums;
  }
  // Restore each product's floor fields to exactly what the pre-up snapshot
  // held (adds nothing back where none existed).
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
