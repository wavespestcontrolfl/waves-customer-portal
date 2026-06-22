/**
 * Make the pre-slab termiticide contextual price floors admin-editable, and
 * drop the dead per-product floor fields.
 *
 * Pre-slab pricing is DB-authoritative (db-bridge.syncConstantsFromDB loads
 * `pricing_config.onetime_preslab` over the in-code constants). The pricing
 * engine's floors come from the contextual `minimums` table
 * (lookupPreSlabMinimum), but that table was never seeded into the config row,
 * so admins had nothing to edit. Meanwhile each product carried
 * `floor_before_volume_discount` / `floor_after_volume_discount` fields that
 * the engine never reads — they rendered in the admin panel as editable inputs
 * that did nothing.
 *
 * This migration read-modify-writes the existing row to:
 *   1. add the `minimums` block (mirroring constants.js) if absent, preserving
 *      any admin edits already present, and
 *   2. strip the dead per-product floor fields.
 *
 * No price values change — this only makes the live floors editable and removes
 * the dead inputs.
 */
const MIGRATION_TAG = 'migration:20260622000000';
const UP_REASON = 'Pre-slab: seed editable contextual minimums + drop dead per-product floor fields';
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

// The dead per-product floors removed by up() / restored by down().
const LEGACY_PRODUCT_FLOORS = { floor_before_volume_discount: 600, floor_after_volume_discount: 500 };

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
      Object.entries(newData.products).map(([key, product]) => {
        if (!product || typeof product !== 'object') return [key, product];
        const { floor_before_volume_discount, floor_after_volume_discount, ...rest } = product;
        return [key, rest];
      }),
    );
  }
  await save(knex, data, newData, UP_REASON);
};

exports.down = async function down(knex) {
  // Only revert what this migration created — keyed off our audit row — so a
  // later admin edit to minimums isn't silently destroyed on an unrelated
  // rollback. No audit table means no proof of ownership; leave data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'onetime_preslab', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  const loaded = await loadConfig(knex);
  if (!loaded) return;
  const { data } = loaded;

  const newData = { ...data };
  delete newData.minimums;
  if (newData.products && typeof newData.products === 'object') {
    newData.products = Object.fromEntries(
      Object.entries(newData.products).map(([key, product]) => {
        if (!product || typeof product !== 'object') return [key, product];
        return [key, { ...product, ...LEGACY_PRODUCT_FLOORS }];
      }),
    );
  }
  await save(knex, data, newData, DOWN_REASON);
};
